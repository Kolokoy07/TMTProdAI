#!/usr/bin/env node
// Coaching Calls: cut vertical clips from a call recording with plain FFmpeg.
//   node clip.mjs [c01 c02 ...]      (all clips in clips.json when none given)
// Screen-share recordings: "chartRanges" [[from, to]] marks source seconds where the share is on; those parts (or segs marked
// "chart") use the "share" split (chart fitted in the top half, coach webcam filling the bottom half), with
// "share": { chart: [x, y, w, h], cam: [x, y, w, h] } in source pixels.
// Student talking, no charts: "studentRanges" [[from, to]] or segs marked "student" put a first-name card on top and the
// coach listening below ("listen": { at, len, crop }); "studentchart" segs put the student's share ("studentShare".chart) on top.
// clips.json: { "name", "cx"?, "clips": [{ id, slug, hook: ["line", "*accent* line"], segs: [[start, end, "chart"|"student"?], ...] }] }
// Camera parts: square crop around cx (fraction of width), 1080x1080.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as fontkit from 'fontkit';

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
// Hook lines are measured with the real font (libass sizes text by winAscent + winDescent) so each gets its own
// rounded red box, and shrink so the widest stays inside 920 px.
const font = fontkit.openSync('fonts/ariblk.ttf');
const textW = (t, size) => font.layout(t).advanceWidth * size / (font['OS/2'].winAscent + font['OS/2'].winDescent);
const hookSize = (lines) => Math.min(S.hook.size, Math.floor(S.hook.size * 920 / Math.max(...lines.map((l) => textW(l, S.hook.size) + 2 * S.hook.padX))));
const roundBox = (w, h, r) => {
  const k = r * 0.45, f = (n) => Math.round(n);
  return `m ${f(r)} 0 l ${f(w - r)} 0 b ${f(w - k)} 0 ${f(w)} ${f(k)} ${f(w)} ${f(r)} l ${f(w)} ${f(h - r)} b ${f(w)} ${f(h - k)} ${f(w - k)} ${f(h)} ${f(w - r)} ${f(h)}` +
    ` l ${f(r)} ${f(h)} b ${f(k)} ${f(h)} 0 ${f(h - k)} 0 ${f(h - r)} l 0 ${f(r)} b 0 ${f(k)} ${f(k)} 0 ${f(r)} 0`;
};
// Hook events: one rounded box per line, stacked up from `bottom`, text centred on each box.
const hookEvents = (lines, bottom, end) => {
  const fs = hookSize(lines), K = S.hook, bh = Math.round(fs + 2 * K.pad);
  return lines.map((l, i) => {
    const bw = Math.round(textW(l, fs) + 2 * K.padX), top = bottom - (lines.length - i) * bh - (lines.length - 1 - i) * K.gap;
    const x = Math.round((W - bw) / 2);
    return `Dialogue: 1,${ts(0)},${ts(end)},HookBox,,0,0,0,,{\\an7\\pos(${x},${top})\\p1}${roundBox(bw, bh, K.radius)}{\\p0}\n` +
      `Dialogue: 2,${ts(0)},${ts(end)},HookText,,0,0,0,,{\\an5\\pos(${W / 2},${Math.round(top + bh / 2 + fs * K.nudge)})\\fs${fs}}${l}`;
  }).join('\n');
};

// Coach-only background (the Coach Tim reels look): black, soft colour glows, faint white grid. Made once per run.
const bgFile = 'review/coach-bg.png';
if (S.layout.camera.grid) {
  const g = S.layout.camera.grid, BW = W + g.cell, BH = H + g.cell;
  const blob = ([x, y, r, a]) => `${a}*pow(max(0\\,1-hypot(X-${x}\\,Y-${y})/${r})\\,2)`;
  const ch = (k) => g.glows.map((gl) => `${blob(gl)}*${parseInt(gl[4].slice(1 + 2 * k, 3 + 2 * k), 16)}`).join('+');
  run(['-f', 'lavfi', '-i', `color=c=${g.base.replace('#', '0x')}:s=${BW}x${BH}:d=1`, '-vf',
    `format=rgb24,geq=r='r(X\\,Y)+${ch(0)}':g='g(X\\,Y)+${ch(1)}':b='b(X\\,Y)+${ch(2)}',` +
    `drawgrid=w=${g.cell}:h=${g.cell}:t=1:c=white@${g.lineAlpha}`, '-frames:v', '1', '-update', '1', bgFile]);
}

for (const clip of cfg.clips) {
  if (want.length && !want.includes(clip.id)) continue;
  // Keep ranges: speech only, split at gaps longer than GAP, so pauses and dead air are cut.
  const pieces = [];
  const inRanges = (r, t) => (r ?? []).some(([a, b]) => t >= a && t < b);
  const listen = clip.listen ?? cfg.listen;
  // A seg's 4th value is the student's first name (student parts) or its own chart crop [x, y, w, h] (chart parts),
  // for calls where the shared window moves or changes size.
  for (const [s, e, given, opt] of clip.segs) {
    const mid = (s + e) / 2;
    const kind = given === 'chart' ? 'share' : given ?? (inRanges(cfg.chartRanges, mid) ? 'share' : inRanges(clip.studentRanges ?? cfg.studentRanges, mid) ? 'student' : 'camera');
    const name = typeof opt === 'string' ? opt : clip.student;
    const chart = Array.isArray(opt) ? opt : (kind === 'studentchart' ? cfg.studentShare : cfg.share)?.chart;
    if ((kind === 'share' || kind === 'studentchart') && !chart) throw new Error(`${clip.id}: chart parts need a chart crop ("share"/"studentShare" in clips.json or a 4th seg value)`);
    if (kind === 'share' && !cfg.share?.cam) throw new Error(`${clip.id}: chart parts need "share.cam" (the coach webcam crop) in clips.json`);
    if ((kind === 'student' || kind === 'studentchart') && !listen) throw new Error(`${clip.id}: student parts need "listen" (coach listening shot) in clips.json`);
    if (kind === 'student' && !name) throw new Error(`${clip.id}: student parts need the student's first name ("student" or a 4th seg value)`);
    // Words belong to the part they start in, so a word straddling a layout switch is never dropped.
    const ws = words.filter((w) => w.start >= s - 0.01 && w.start < e);
    let cur = null;
    for (const w of ws) {
      if (cur && w.start - cur.lastEnd <= GAP) { cur.end = Math.max(cur.end, w.end); cur.lastEnd = cur.end; cur.words.push(w); continue; }
      if (cur) pieces.push(cur);
      cur = { start: w.start, end: w.end, lastEnd: w.end, kind, name, chart, words: [w] };
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
  // Coach listening shot for student parts (Zoom does not show the coach then): a ping-pong loop of the quiet window
  // (forward, then reversed) made once, read from where the last student part left off so it never snaps back.
  const extra = [];
  let heard = 0;
  const loopFile = listen && `review/listen-${listen.at}-${listen.len}.mp4`;
  if (listen && !existsSync(loopFile)) run(['-ss', String(listen.at), '-t', String(listen.len), '-i', 'assets/raw.mp4', '-filter_complex',
    `[0:v]fps=30,${fill(listen.crop)},split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[o]`, '-map', '[o]', '-an', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', loopFile]);
  const listenInput = (d) => {
    const at = heard % (2 * listen.len);
    heard += d;
    extra.push(['-stream_loop', '-1', '-ss', at.toFixed(3), '-t', d.toFixed(3), '-i', loopFile]);
    return pieces.length + extra.length - 1;
  };
  const F = 'fonts/ariblk.ttf';
  // Student card (camera off): dark panel, initial in a tile, first name, red STUDENT pill. Never the surname.
  const card = (name, d) => `color=c=0x161616:s=${W}x${HALF}:r=30:d=${d.toFixed(3)},drawbox=x=${W / 2 - 125}:y=380:w=250:h=250:color=0x2A2A2A:t=fill,` +
    `drawtext=fontfile=${F}:text='${name[0].toUpperCase()}':fontsize=150:fontcolor=white:x=(w-tw)/2:y=420,` +
    `drawtext=fontfile=${F}:text='${name.toUpperCase()}':fontsize=80:fontcolor=white:x=(w-tw)/2:y=670,` +
    `drawtext=fontfile=${F}:text=' STUDENT ':fontsize=36:fontcolor=white:box=1:boxcolor=0xE3161D:boxborderw=10:x=(w-tw)/2:y=780`;
  // Continuous split: while a camera-off student talks, hold a still of the clip's nearest chart (the next one, else the
  // one before) on top instead of the student card, so the split never breaks. The card is used only when the clip has
  // no chart, or when the style's student mode is "card".
  const charted = pieces.filter((q) => q.chart);
  if (S.layout.student.mode !== 'card') pieces.forEach((p, i) => {
    if (p.kind !== 'student') return;
    const near = pieces.slice(i + 1).find((q) => q.chart) ?? charted.filter((q) => q.end <= p.start).at(-1);
    if (near) p.hold = { t: (near.a + near.b) / 2, chart: near.chart };
  });
  pieces.forEach((p, i) => {
    const dark = p.kind === 'share' ? camDark.filter(([a, b]) => b - a >= 0.5 && a < p.b && b > p.a).map(([a, b]) => [Math.max(0, a - p.a), Math.min(p.b, b) - p.a]) : [];
    for (const [a, b] of dark) labels.push([off + a, off + b]);
    off += p.b - p.a;
    // "camBox" [x, y, w, h]: the camera picture inside Zoom's letterbox bars, cropped first so no black bars show.
    const box = cfg.camBox ? `crop=${cfg.camBox[2]}:${cfg.camBox[3]}:${cfg.camBox[0]}:${cfg.camBox[1]},` : '';
    const square = `${box}crop=ih:ih:'max(0,min(iw-ih,iw*${cx}-ih/2))':0,scale=${sq.size}:${sq.size}:flags=lanczos,unsharp=5:5:0.6`;
    const look = `${square},pad=${W}:${H}:0:${sq.y}:black`;
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
      const [chx, chy, chw, chh] = p.chart;
      f.push(`${src},fps=30,split[sc${i}][sk${i}]`);
      f.push(`[sc${i}]crop=${chw}:${chh}:${chx}:${chy},scale=${W}:${HALF}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:${HALF}-ih:black[sb${i}]`);
      f.push(`[sk${i}]${fill(cfg.share.cam)}[sf${i}]`);
      const show = dark.length ? `:enable='not(${dark.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+')})'` : '';
      f.push(`[sb${i}][sf${i}]overlay=0:${HALF}${show},setsar=1[v${i}]`);
    } else if (p.kind === 'student' || p.kind === 'studentchart') {
      // Top: the student's card (camera off) or the student's own chart share. Bottom: the coach listening.
      const d = p.b - p.a, li = listenInput(d);
      if (p.kind === 'student' && p.hold) {
        const [chx, chy, chw, chh] = p.hold.chart;
        extra.push(['-ss', p.hold.t.toFixed(3), '-i', 'assets/raw.mp4']);
        const hi = pieces.length + extra.length - 1;
        f.push(`${src},nullsink`, `[${hi}:v]trim=end_frame=1,loop=loop=${Math.ceil(d * 30)}:size=1:start=0,setpts=N/30/TB,` +
          `crop=${chw}:${chh}:${chx}:${chy},scale=${W}:${HALF}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:${HALF}-ih:black[sb${i}]`);
      } else if (p.kind === 'student') f.push(`${src},nullsink`, `${card(p.name, d)},pad=${W}:${H}:0:0:black[sb${i}]`);
      else {
        const [chx, chy, chw, chh] = p.chart;
        f.push(`${src},fps=30,crop=${chw}:${chh}:${chx}:${chy},scale=${W}:${HALF}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:${HALF}-ih:black[sb${i}]`);
      }
      f.push(`[${li}:v]setpts=PTS-STARTPTS,fps=30[sf${i}]`);
      f.push(`[sb${i}][sf${i}]overlay=0:${HALF}:shortest=1,setsar=1[v${i}]`);
    } else if (sq.grid) {
      // Coach-only frames sit on the Coach Tim reels background: one cell larger than the frame, cropped at a moving
      // offset so the grid drifts slowly and seamlessly through the whole clip.
      const g = sq.grid, d = p.b - p.a, t0 = off - d;
      extra.push(['-loop', '1', '-framerate', '30', '-t', d.toFixed(3), '-i', bgFile]);
      const bi = pieces.length + extra.length - 1;
      f.push(`[${bi}:v]crop=${W}:${H}:'mod((t+${t0.toFixed(3)})*${g.drift[0]},${g.cell})':'mod((t+${t0.toFixed(3)})*${g.drift[1]},${g.cell})'[g${i}]`);
      f.push(`${src},fps=30,${square}[s${i}]`);
      f.push(`[g${i}][s${i}]overlay=0:${sq.y}:shortest=1,setsar=1[v${i}]`);
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
  const first = pieces[0]?.hold ? 'share' : pieces[0]?.kind;
  if (pieces[0]?.hold) pieces[0].chart = pieces[0].hold.chart;
  const top = (box) => (box ? HALF - Math.min(HALF, Math.round(W * box[3] / box[2])) : HALF);
  const chartTop = top(pieces[0]?.chart);
  // The band above a chart is used only when the whole hook fits below the top safe margin (app UI sits up there).
  const hookH = clip.hook.length * (hookSize(clip.hook.map((l) => l.toUpperCase())) + 2 * K.pad) + (clip.hook.length - 1) * K.gap;
  const inBand = Math.min(S.layout.share.hookBottom, chartTop - 24);
  const hookBottom = clip.hookBottom ?? cfg.hookBottom ?? (first === 'share' || first === 'studentchart' ? (inBand - hookH >= S.layout.share.topSafe ? inBand : S.layout.share.hookOver) : first === 'student' ? S.layout.student.hookBottom : K.bottom);
  const assFile = `review/${clip.id}.ass`;
  writeFileSync(assFile, `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 1
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: HookBox,${K.font},${K.size},${ass(S.colours.hookBox)},${ass(S.colours.hookBox)},${ass(S.colours.hookBox)},${ass(S.colours.hookBox)},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: HookText,${K.font},${K.size},${ass(S.colours.hook)},${ass(S.colours.hook)},${ass(S.colours.hook)},${ass(S.colours.hook)},0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: CapSeam,${C.font},${C.size},${ass(S.colours.caption)},${ass(S.colours.caption)},${ass(S.colours.captionBox)},${ass(S.colours.captionBox)},0,0,0,0,100,100,0,0,3,14,0,2,60,60,${H - S.layout.seamCapY},1
Style: Who,${C.font},44,&H00FFFFFF&,&H00FFFFFF&,&H00333333&,&H00333333&,0,0,0,0,100,100,0,0,3,16,0,5,60,60,0,1
Style: Cap,${C.font},${C.size},${ass(S.colours.caption)},${ass(S.colours.caption)},${ass(S.colours.captionBox)},${ass(S.colours.captionBox)},0,0,0,0,100,100,0,0,3,14,0,2,60,60,${H - C.y},1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${hookEvents(clip.hook.map((l) => l.toUpperCase()), hookBottom, Math.min(total, S.hook.seconds ?? total))}
${labels.map(([a, b]) => `Dialogue: 0,${ts(a)},${ts(b)},Who,,0,0,0,,{\\pos(${W / 2},${HALF * 1.5})}STUDENT`).join('\n')}
${caps.map(([a, b, x, k]) => `Dialogue: 0,${ts(a)},${ts(b)},${k === 'camera' ? 'Cap' : 'CapSeam'},,0,0,0,,${x.toUpperCase()}`).join('\n')}
`);
  f.push(`[cv]subtitles=${assFile}:fontsdir=fonts[ov]`);
  f.push(`[ca]highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000[oa]`);
  writeFileSync(`review/${clip.id}.filter.txt`, f.join(';\n'));

  const out = `renders/${clip.id}.mp4`;
  run([...pieces.flatMap((p) => ['-ss', p.a.toFixed(3), '-t', (p.b - p.a).toFixed(3), '-i', 'assets/raw.mp4']),
    ...extra.flat(), '-/filter_complex', `review/${clip.id}.filter.txt`, '-map', '[ov]', '-map', '[oa]',
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
