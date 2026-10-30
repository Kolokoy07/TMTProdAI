// Cuts each reel from the 4K source: takes the words inside each listed segment (segments can be in
// any order, so lines can be rearranged), removes every pause longer than GAP (tight cuts, no speed-ups),
// and writes assets/<id>/clip.mp4 (2560x1440, keyframe every 30 frames) plus assets/<id>/transcript.json
// retimed to the clip, with caption spelling fixes applied.
//   node cut.mjs [r01 r02 ...]   (all reels when no ids are given)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// the original recording, set by prep.mjs in source.json (never modified)
const CFG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'source.json'), 'utf8'));
const SRC = CFG.source;
// camera bubble crops (w:h:x:y) in the 3840x2160 source, inset past its rounded border
// defaults measured on a 3840x2160 recording; override per video with "face" in source.json
const FACE = CFG.face || { L: [840, 466, 67, 1587], R: [840, 466, 2963, 1624], C: [2880, 1600, 480, 200], T: [840, 466, 90, 55] }; // C: full-screen camera shots, T: top-left bubble (MateRadar pages)
const FPS = 30, GAP = 0.3, PAD_IN = 0.08, PAD_OUT = 0.1, QUIET = -30;
// 20 ms RMS levels (dB) of the whole recording, from assets/full.wav
const RMS = new Float32Array(new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'assets', 'rms20ms.f32'))).buffer);
const all = JSON.parse(readFileSync(join(here, 'reels.json'), 'utf8'));
const ids = process.argv.slice(2);
const reels = ids.length ? all.filter((r) => ids.includes(r.id)) : all;
const W = JSON.parse(readFileSync(join(here, 'assets', 'full.json'), 'utf8')).words;

// Whisper's spellings of product names and Taglish words, fixed for captions
const FIX = [
  [/^Mate\.?ai|^MateAI|^Mate-AI/i, 'Mate AI'], [/^MatePortal|^Mate-?portal/i, 'Mate Portal'],
  [/^Maitradar|^Matradar|^Materadar/i, 'MateRadar'], [/^Barreplay|^Bar-?replay/i, 'Bar Replay'],
  [/^24x7/, '24/7'], [/^NGDCHF|^NZD-CHF/, 'NZDCHF'], [/^EUDCAD/, 'AUDCAD'], [/^Kusan$/, 'Kusang'], [/^kusan$/, 'kusang'],
  [/^nagugusuhan/, 'nagugustuhan'], [/^pinutin/, 'pindutin'], [/^pipinutin/, 'pipindutin'], [/^kuhang-kuhan/, 'kuhang-kuha'],
  [/^nakakalam/, 'nakakaalam'], [/^iturko/, 'ituro ko'], [/^ituturko/, 'ituturo ko'],
];
const fixWords = (ws) => {
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    const w = { ...ws[i] }, n = ws[i + 1];
    const punct = (w.text.match(/[.,?!]+$/) || [''])[0];
    const pair = n && `${w.text} ${n.text}`;
    if (n && /^May$/i.test(w.text) && /^Trader/i.test(n.text)) { out.push({ ...w, text: 'MateRadar' + (n.text.match(/[.,?!]+$/) || [''])[0], end: n.end }); i++; continue; }
    if (n && /^Bari$/i.test(w.text) && /^Play/i.test(n.text)) { out.push({ ...w, text: 'Bar Replay' + (n.text.match(/[.,?!]+$/) || [''])[0], end: n.end }); i++; continue; }
    if (n && /^UD$/.test(w.text) && /^card/i.test(n.text) && /^a$/i.test(out.at(-1)?.text || '')) { out.at(-1).text = 'AUDCAD' + (n.text.match(/[.,?!]+$/) || [''])[0]; out.at(-1).end = n.end; i++; continue; }
    if (/^same$/i.test(w.text) && n && /^playbook/i.test(n.text)) w.text = 'saved';
    if (n && /^mate$/i.test(w.text) && /^(portal|ai|radar)\b/i.test(n.text)) {
      const p2 = (n.text.match(/[.,?!]+$/) || [''])[0], name = n.text.replace(/[.,?!]+$/, '').toLowerCase();
      out.push({ ...w, text: (name === 'radar' ? 'MateRadar' : name === 'ai' ? 'Mate AI' : 'Mate Portal') + p2, end: n.end }); i++; continue;
    }
    if (/^Ed$/.test(w.text) && /^with$/i.test(out.at(-1)?.text || '')) w.text = 'Edge';
    for (const [re, to] of FIX) if (re.test(w.text)) { w.text = to + punct; break; }
    void pair;
    out.push(w);
  }
  return out;
};

const fr = (t) => Math.round(t * FPS) / FPS;
for (const r of reels) {
  const dir = join(here, 'assets', r.id);
  mkdirSync(dir, { recursive: true });
  const pieces = []; // { s, e, words, seg }
  r.segs.forEach(([s, e], si) => {
    const ws = W.filter((w) => w.start >= s - 0.05 && w.start < e - 0.08);
    // a segment never ends on a dangling connector
    while (ws.length > 1 && /^(and|so|okay|tapos|pero)[,.]?$/i.test(ws.at(-1).text)) ws.pop();
    if (!ws.length) throw new Error(`${r.id}: no words in ${s}-${e}`);
    const a = ws[0].start - PAD_IN, b = Math.max(...ws.map((w) => w.end)) + PAD_OUT;
    // Whisper's word times run across pauses, so pauses come from the audio level: every run under
    // QUIET dB longer than GAP is cut down to PAD_OUT + PAD_IN of breath
    const runs = [];
    let q0 = null;
    for (let f = Math.floor(a / 0.02); f <= Math.ceil(b / 0.02); f++) {
      const quiet = RMS[f] < QUIET;
      if (quiet && q0 === null) q0 = f * 0.02;
      if ((!quiet || f === Math.ceil(b / 0.02)) && q0 !== null) { if (f * 0.02 - q0 > GAP) runs.push([q0, f * 0.02]); q0 = null; }
    }
    let ps = a;
    const bounds = [];
    for (const [q, qe] of runs) {
      const pe = Math.min(b, q + PAD_OUT), ns = Math.max(a, qe - PAD_IN);
      if (pe - ps > 0.25) bounds.push([ps, pe]);
      ps = ns;
    }
    if (b - ps > 0.25) bounds.push([ps, b]);
    // every loud stretch is kept, even when Whisper's times put its word just before the pause
    // reviewed stutters and fillers (reels.json "cuts", source seconds) are left out
    for (const [ca, cb] of r.cuts || []) {
      for (let i = bounds.length - 1; i >= 0; i--) {
        const [x, y] = bounds[i];
        if (cb <= x || ca >= y) continue;
        bounds.splice(i, 1, ...[[x, ca], [cb, y]].filter(([p, q]) => q - p > 0.08));
      }
    }
    for (const [bs, be] of bounds) {
      const pw = ws.filter((w) => { const m = (w.start + Math.min(w.end, w.start + 0.6)) / 2; return m >= bs && m < be; });
      pieces.push({ s: bs, e: be, words: pw, seg: si });
    }
  });
  pieces.forEach((p) => { p.s = fr(p.s); p.e = fr(p.e); });
  // retime words onto the clip
  let t = 0;
  const words = [], joins = [];
  pieces.forEach((p, i) => {
    if (i && p.seg !== pieces[i - 1].seg) joins.push(+t.toFixed(3));
    for (const w of p.words) words.push({ text: w.text, start: +(t + Math.max(0, w.start - p.s)).toFixed(3), end: +(t + Math.min(p.e - p.s, w.end - p.s)).toFixed(3) });
    t += p.e - p.s;
  });
  const DUR = +t.toFixed(3);
  // ffmpeg: one fast-seeked input per piece, short audio fades at every join
  const args = ['-hide_banner', '-v', 'error', '-y'];
  pieces.forEach((p) => args.push('-ss', p.s.toFixed(3), '-t', (p.e - p.s).toFixed(3), '-i', SRC));
  const fc = pieces.map((p, i) => {
    const d = (p.e - p.s).toFixed(3);
    return `[${i}:v]fps=${FPS},setpts=PTS-STARTPTS[v${i}];[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,afade=t=in:d=0.015,afade=t=out:st=${(p.e - p.s - 0.02).toFixed(3)}:d=0.02,apad=whole_dur=${d},atrim=0:${d}[a${i}]`;
  }).join(';') + ';' + pieces.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${pieces.length}:v=1:a=1[vc][a];`
    // screen at 2560x1440, plus Coach Tim's camera bubble cut from the 4K frame at both corners it uses
    // (left, right, centre crop for full-screen camera shots, top-left; each 1080x600) so the reel can show whichever corner holds him
    + `[vc]split=5[s0][s1][s2][s3][s4];[s0]scale=2560:1440:flags=lanczos[v];`
    + `[s1]crop=${FACE.L.join(':')},scale=1080:600:flags=lanczos[fl];[s2]crop=${FACE.R.join(':')},scale=1080:600:flags=lanczos[fr];[s3]crop=${FACE.C.join(':')},scale=1080:600:flags=lanczos[fc];[s4]crop=${FACE.T.join(':')},scale=1080:600:flags=lanczos[ft];[fl][fr][fc][ft]vstack=inputs=4[face]`;
  writeFileSync(join(dir, 'cut-filter.txt'), fc);
  args.push('-/filter_complex', join(dir, 'cut-filter.txt'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-g', '30',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', join(dir, 'clip.mp4'),
    '-map', '[face]', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-g', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'face.mp4'));
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (res.status !== 0) throw new Error(`${r.id}: ${res.stderr}`);
  // captions come from a fresh transcription of the cut clip: exact times on the new timeline and every
  // word kept (the source words above only steer the cut)
  // KEEP_TR=1 keeps the existing transcript (same cut, only the video outputs changed)
  if (process.env.KEEP_TR && existsSync(join(dir, 'transcript.json'))) { console.log(`${r.id} ${DUR.toFixed(1)} s (transcript kept)`); continue; }
  const tr = spawnSync('node', [join(here, '..', '..', '..', 'tools', 'transcribe.mjs'), join(dir, 'clip.mp4')], { encoding: 'utf8' });
  if (tr.status !== 0) throw new Error(`${r.id} transcription: ${tr.stderr || tr.stdout}`);
  const fixed = fixWords(JSON.parse(readFileSync(join(dir, 'clip.json'), 'utf8')).words);
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify({ text: fixed.map((w) => w.text).join(' '), audio_duration_secs: DUR, joins, pieces: pieces.map((p) => [p.s, p.e]), words: fixed }, null, 1));
  console.log(`${r.id} ${DUR.toFixed(1)} s, ${pieces.length} pieces, joins ${joins.join(', ')}`);
}
