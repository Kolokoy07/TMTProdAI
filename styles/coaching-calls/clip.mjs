#!/usr/bin/env node
// Coaching Calls: cut vertical clips from a call recording with plain FFmpeg.
//   node clip.mjs [c01 c02 ...]      (all clips in clips.json when none given)
// Screen-share recordings: "chartRanges" [[from, to]] marks source seconds where the share is on; those parts (or segs marked
// "chart") use the "share" split (chart fitted in the top half, coach webcam filling the bottom half), with
// "share": { chart: [x, y, w, h], cam: [x, y, w, h] } in source pixels.
// Student talking: "studentRanges" [[from, to]] or segs marked "student" use the "student" split (student tile fills the top
// half, coach tile the bottom half), with "split": { student: [x, y, w, h], coach: [x, y, w, h] } (whole call or per clip).
// clips.json: { "name", "cx"?, "clips": [{ id, slug, hook: ["line", "*accent* line"], segs: [[start, end, "chart"|"student"?], ...] }] }
// Camera parts: square crop around cx (fraction of width), 1080x1080.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const S = JSON.parse(readFileSync('../../../styles/coaching-calls.json', 'utf8'));
const cfg = JSON.parse(readFileSync('clips.json', 'utf8'));
const words = JSON.parse(readFileSync('assets/raw.json', 'utf8')).words;
// Source spans where the share's webcam bubble is black (a student with camera off is talking): the panel hides
// and a STUDENT label shows instead. Made by scanning the bubble; optional.
const camDark = existsSync('assets/camdark.json') ? JSON.parse(readFileSync('assets/camdark.json', 'utf8')) : [];
const [W, H] = [1080, 1920];
// --final: approved version, higher quality, saved as <name>-NN-<topic>-final.mp4.
const FINAL = process.argv.includes('--final');
const want = process.argv.slice(2).filter((a) => a !== '--final');
const GAP = S.cuts.maxGap, PADIN = S.cuts.padIn, PADOUT = S.cuts.padOut;
mkdirSync('renders', { recursive: true });
mkdirSync('review', { recursive: true });

const run = (args) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(r.stderr);
};
const ts = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
};
const ass = (hex) => '&H00' + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3) + '&';
// Hook lines shrink so each stays on one line inside 920 px.
const hookSize = (lines) => Math.min(S.hook.size, Math.floor(920 / (0.74 * Math.max(...lines.map((l) => l.length)))));

for (const clip of cfg.clips) {
  if (want.length && !want.includes(clip.id)) continue;
  // Keep ranges: speech only, split at gaps longer than GAP, so pauses and dead air are cut.
  const pieces = [];
  const inRanges = (r, t) => (r ?? []).some(([a, b]) => t >= a && t < b);
  for (const [s, e, given] of clip.segs) {
    const mid = (s + e) / 2;
    const kind = given === 'chart' ? 'share' : given ?? (inRanges(cfg.chartRanges, mid) ? 'share' : inRanges(clip.studentRanges ?? cfg.studentRanges, mid) ? 'student' : 'camera');
    if (kind === 'share' && !cfg.share) throw new Error(`${clip.id}: chart parts need "share" crops in clips.json`);
    if (kind === 'student' && !(clip.split ?? cfg.split)) throw new Error(`${clip.id}: student parts need "split" crops in clips.json`);
    const ws = words.filter((w) => w.start >= s - 0.01 && w.end <= e + 0.01);
    let cur = null;
    for (const w of ws) {
      if (cur && w.start - cur.lastEnd <= GAP) { cur.end = Math.max(cur.end, w.end); cur.lastEnd = cur.end; cur.words.push(w); continue; }
      if (cur) pieces.push(cur);
      cur = { start: w.start, end: w.end, lastEnd: w.end, kind, words: [w] };
    }
    if (cur) pieces.push(cur);
  }
  pieces.forEach((p, i) => {
    const prev = pieces[i - 1], next = pieces[i + 1];
    p.a = Math.max(p.start - PADIN, prev && prev.end <= p.start && prev.kind === p.kind ? (prev.end + p.start) / 2 : 0);
    p.b = Math.min(p.end + PADOUT, next && next.start >= p.end ? (p.end + next.start) / 2 : Infinity);
  });

  // Video and audio per piece, then concat.
  const sq = S.layout.camera, HALF = S.layout.half;
  const cx = clip.cx ?? cfg.cx ?? sq.cx;
  // Split halves: crop a source box and zoom it to fill 1080x960, no borders.
  const fill = ([x, y, w, h]) => `crop=${w}:${h}:${x}:${y},scale=${W}:${HALF}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${HALF},unsharp=5:5:0.8`;
  const f = [];
  let off = 0;
  const labels = [];
  pieces.forEach((p, i) => {
    const dark = p.kind === 'share' ? camDark.filter(([a, b]) => b - a >= 0.5 && a < p.b && b > p.a).map(([a, b]) => [Math.max(0, a - p.a), Math.min(p.b, b) - p.a]) : [];
    for (const [a, b] of dark) labels.push([off + a, off + b]);
    off += p.b - p.a;
    const look = `crop=ih:ih:'max(0,min(iw-ih,iw*${cx}-ih/2))':0,scale=${sq.size}:${sq.size}:flags=lanczos,unsharp=5:5:0.6,pad=${W}:${H}:0:${sq.y}:black`;
    // Student surnames: blur boxes in source pixels and source seconds, from clips.json "blur" (whole call) or a clip's own.
    const boxes = [...(cfg.blur ?? []), ...(clip.blur ?? [])].filter((b) => b.from < p.b && b.to > p.a);
    // Each piece is its own input seeked to its start, so long or 4K recordings are not decoded from the top.
    let src = `[${i}:v]setpts=PTS-STARTPTS`;
    boxes.forEach((b, k) => {
      const on = `between(t,${Math.max(0, b.from - p.a)},${b.to - p.a})`;
      f.push(`${src},split[m${i}_${k}][c${i}_${k}]`);
      f.push(`[c${i}_${k}]crop=${b.w}:${b.h}:${b.x}:${b.y},boxblur=8:3[b${i}_${k}]`);
      f.push(`[m${i}_${k}][b${i}_${k}]overlay=${b.x}:${b.y}:enable='${on}'[u${i}_${k}]`);
      src = `[u${i}_${k}]null`;
    });
    if (p.kind === 'share') {
      // Chart fitted inside the top half, sitting on the seam (a wide chart leaves a black band above it for the hook).
      const [chx, chy, chw, chh] = cfg.share.chart;
      f.push(`${src},fps=30,split[sc${i}][sk${i}]`);
      f.push(`[sc${i}]crop=${chw}:${chh}:${chx}:${chy},scale=${W}:${HALF}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:${HALF}-ih:black[sb${i}]`);
      f.push(`[sk${i}]${fill(cfg.share.cam)}[sf${i}]`);
      const show = dark.length ? `:enable='not(${dark.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+')})'` : '';
      f.push(`[sb${i}][sf${i}]overlay=0:${HALF}${show},setsar=1[v${i}]`);
    } else if (p.kind === 'student') {
      const sp = clip.split ?? cfg.split;
      f.push(`${src},fps=30,split[st${i}][co${i}]`);
      f.push(`[st${i}]${fill(sp.student)},pad=${W}:${H}:0:0:black[sb${i}]`);
      f.push(`[co${i}]${fill(sp.coach)}[sf${i}]`);
      f.push(`[sb${i}][sf${i}]overlay=0:${HALF},setsar=1[v${i}]`);
    } else f.push(`${src},fps=30,${look},setsar=1[v${i}]`);
    const d = p.b - p.a;
    f.push(`[${i}:a]asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=${Math.max(0, d - 0.015)}:d=0.015[a${i}]`);
  });
  f.push(pieces.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${pieces.length}:v=1:a=1[cv][ca]`);

  // Captions retimed onto the edited timeline; one short line each.
  let t = 0, caps = [], line = [], lineStart = 0;
  let lineKind = 'camera';
  const flush = (end) => { if (line.length) caps.push([lineStart, end, line.join(' '), lineKind]); line = []; };
  for (const p of pieces) {
    for (const w of p.words) {
      const ws = Math.max(t + (w.start - p.a), caps.at(-1)?.[1] ?? 0, lineStart), we = Math.max(ws, t + (w.end - p.a));
      let txt = w.text.trim();
      for (const [from, to] of clip.fix ?? []) txt = txt.replace(new RegExp(`^${from}$`, 'i'), to);
      if (line.length && (line.join(' ') + ' ' + txt).length > S.captions.maxChars) flush(ws);
      if (!line.length) { lineStart = ws; lineKind = p.kind; }
      line.push(txt);
      if (/[.?!]$/.test(txt)) flush(we + 0.15);
    }
    t += p.b - p.a;
  }
  flush(t);
  for (let i = 0; i < caps.length - 1; i++) caps[i][1] = Math.max(caps[i][0] + 0.2, Math.min(Math.max(caps[i][1], caps[i][0] + 0.4), caps[i + 1][0]));
  // A caption must end after it starts, or FFmpeg drops the whole subtitle track (hook included).
  for (const c of caps) if (c[1] <= c[0] + 0.1) c[0] = Math.max(0, c[1] - 0.3);
  const total = t;

  const C = S.captions, K = S.hook;
  // Hook sits where the opening layout has room: coach's chest, the band above the chart, or the student's chest.
  const first = pieces[0]?.kind;
  const chartTop = cfg.share ? HALF - Math.min(HALF, Math.round(W * cfg.share.chart[3] / cfg.share.chart[2])) : HALF;
  const hookBottom = clip.hookBottom ?? cfg.hookBottom ?? (first === 'share' ? Math.min(S.layout.share.hookBottom, chartTop - 24) : first === 'student' ? S.layout.student.hookBottom : K.bottom);
  const assFile = `review/${clip.id}.ass`;
  writeFileSync(assFile, `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 1
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${K.font},${K.size},${ass(S.colours.hook)},${ass(S.colours.hook)},${ass(S.colours.hookBox)},${ass(S.colours.hookBox)},0,0,0,0,100,100,0,0,3,${K.pad},0,2,60,60,${H - hookBottom},1
Style: CapSeam,${C.font},${C.size},${ass(S.colours.caption)},${ass(S.colours.caption)},${ass(S.colours.captionBox)},${ass(S.colours.captionBox)},0,0,0,0,100,100,0,0,3,14,0,2,60,60,${H - S.layout.seamCapY},1
Style: Who,${C.font},44,&H00FFFFFF&,&H00FFFFFF&,&H00333333&,&H00333333&,0,0,0,0,100,100,0,0,3,16,0,5,60,60,0,1
Style: Cap,${C.font},${C.size},${ass(S.colours.caption)},${ass(S.colours.caption)},${ass(S.colours.captionBox)},${ass(S.colours.captionBox)},0,0,0,0,100,100,0,0,3,14,0,2,60,60,${H - C.y},1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,${ts(0)},${ts(Math.min(total, S.hook.seconds ?? total))},Hook,,0,0,0,,{\\fs${hookSize(clip.hook)}}${clip.hook.map((l) => l.toUpperCase()).join('\\N')}
${labels.map(([a, b]) => `Dialogue: 0,${ts(a)},${ts(b)},Who,,0,0,0,,{\\pos(${W / 2},${HALF * 1.5})}STUDENT`).join('\n')}
${caps.map(([a, b, x, k]) => `Dialogue: 0,${ts(a)},${ts(b)},${k === 'camera' ? 'Cap' : 'CapSeam'},,0,0,0,,${x.toUpperCase()}`).join('\n')}
`);
  f.push(`[cv]subtitles=${assFile}:fontsdir=fonts[ov]`);
  f.push(`[ca]highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000[oa]`);
  writeFileSync(`review/${clip.id}.filter.txt`, f.join(';\n'));

  const out = `renders/${clip.id}.mp4`;
  run([...pieces.flatMap((p) => ['-ss', p.a.toFixed(3), '-t', (p.b - p.a).toFixed(3), '-i', 'assets/raw.mp4']), '-/filter_complex', `review/${clip.id}.filter.txt`, '-map', '[ov]', '-map', '[oa]',
    '-c:v', 'libx264', ...(FINAL ? ['-preset', 'slow', '-crf', '16'] : ['-preset', 'medium', '-crf', '19']), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  const dest = `../../../outbox/${cfg.name}/${cfg.name}-${clip.id.replace('c', '')}-${clip.slug}-${FINAL ? 'final' : cfg.version ?? 'v1'}.mp4`;
  mkdirSync(`../../../outbox/${cfg.name}`, { recursive: true });
  copyFileSync(out, dest);
  // Frame sheet for review.
  const at = [0.04, 0.2, 0.36, 0.52, 0.68, 0.86].map((x) => (x * total).toFixed(2));
  run([...at.flatMap((s) => ['-ss', s, '-i', out]), '-filter_complex',
    at.map((_, k) => `[${k}:v]scale=270:-1,trim=end_frame=1[s${k}]`).join(';') + ';' + at.map((_, k) => `[s${k}]`).join('') + 'hstack=inputs=6',
    '-frames:v', '1', '-update', '1', `review/${clip.id}-sheet.jpg`]);
  console.log(`${clip.id}  ${total.toFixed(1)}s  ${pieces.length} cuts  -> ${dest}`);
}
