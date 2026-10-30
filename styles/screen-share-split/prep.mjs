// First step of a Screen-share split edit, run from the project folder (kit/video-projects/<slug>):
//   node prep.mjs "<path to recording>" <name>
// Writes source.json, assets/full.wav (16 kHz mono), assets/rms20ms.f32 (20 ms levels the cutter uses
// to find pauses), and assets/full.json + assets/full-readable.txt (the whole talk, word-timed).
// Groq's free tier takes about 26 minutes of audio per upload, so longer recordings are transcribed in
// parts that each end on a finished sentence.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [src, name] = process.argv.slice(2);
if (!src || !name || !existsSync(src)) { console.error('Usage: node prep.mjs "<recording>" <name>'); process.exit(1); }
const A = join(here, 'assets'), P = join(A, 'parts');
mkdirSync(P, { recursive: true });
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const old = existsSync(join(here, 'source.json')) ? JSON.parse(readFileSync(join(here, 'source.json'), 'utf8')) : {};
writeFileSync(join(here, 'source.json'), JSON.stringify({ ...old, source: resolve(src).replace(/\\/g, '/'), name }, null, 2));
const DUR = +run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]);

run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', join(A, 'full.wav')]);
const wav = readFileSync(join(A, 'full.wav'));
let off = 12;
while (wav.toString('ascii', off, off + 4) !== 'data') off += 8 + wav.readUInt32LE(off + 4);
off += 8;
const F = Math.floor((wav.length - off) / 2 / 320), db = new Float32Array(F);
for (let f = 0; f < F; f++) {
  let s = 0;
  for (let k = 0; k < 320; k++) { const v = wav.readInt16LE(off + 2 * (f * 320 + k)) / 32768; s += v * v; }
  db[f] = 10 * Math.log10(s / 320 + 1e-10);
}
writeFileSync(join(A, 'rms20ms.f32'), Buffer.from(db.buffer));

// transcribe in parts of at most PART seconds, each cut after a sentence end followed by a pause
const PART = 1560, transcribe = join(here, '..', '..', '..', 'tools', 'transcribe.mjs');
const words = [];
let start = 0, n = 0;
while (start < DUR - 1) {
  const len = Math.min(PART, DUR - start), f = join(P, `part${++n}.m4a`);
  run('ffmpeg', ['-v', 'error', '-y', '-ss', String(start), '-t', String(len), '-i', join(A, 'full.wav'), '-c:a', 'aac', '-b:a', '96k', f]);
  run('node', [transcribe, f]);
  const ws = JSON.parse(readFileSync(f.replace(/\.m4a$/, '.json'), 'utf8')).words.map((w) => ({ ...w, start: +(w.start + start).toFixed(3), end: +(w.end + start).toFixed(3) }));
  let cut = start + len;
  if (start + len < DUR - 1) {
    // last sentence end with a pause in the final 2 minutes of this part
    for (let i = ws.length - 2; i >= 0; i--) {
      if (ws[i].end < cut - 120) break;
      if (/[.?!]$/.test(ws[i].text) && ws[i + 1].start - ws[i].end > 0.35) { cut = +((ws[i].end + ws[i + 1].start) / 2).toFixed(2); break; }
    }
  }
  words.push(...ws.filter((w) => w.start < cut - 0.05));
  console.log(`part ${n}: ${start.toFixed(1)}-${cut.toFixed(1)} s, ${ws.length} words`);
  start = cut;
}
writeFileSync(join(A, 'full.json'), JSON.stringify({ text: words.map((w) => w.text).join(' '), audio_duration_secs: DUR, words }, null, 1));
const mm = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
let out = '', line = [], t0 = 0;
words.forEach((w, i) => {
  if (!line.length) t0 = w.start;
  line.push(w.text);
  const nx = words[i + 1];
  if (/[.?!]$/.test(w.text) || !nx || nx.start - w.end > 0.6 || line.length > 28) { out += `[${mm(t0)} ${t0.toFixed(1)}] ${line.join(' ')}\n`; line = []; }
});
writeFileSync(join(A, 'full-readable.txt'), out);
console.log(`${words.length} words, ${DUR.toFixed(0)} s -> assets/full.json, assets/full-readable.txt`);
