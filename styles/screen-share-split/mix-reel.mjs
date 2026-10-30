// Sound pass per reel: the format's approved sound set (impact, swish, shimmer, swell, pop, whoosh,
// ambient pad, a riser sized to the 4.6 s hook), mixed at assets/<id>/cues.json times with the
// normalized voice and the pad about 20 dB under the voice, ducked under speech. Writes assets/<id>/audio.wav.
//   node mix-reel.mjs r01 [r02 ...]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const S = join(here, 'assets', 'sfx');
// the format's sound set lives with the style: styles/screen-share-split/sounds
const SOUNDS = join(here, '..', '..', '..', 'styles', 'screen-share-split', 'sounds');
mkdirSync(S, { recursive: true });
const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
};
if (!existsSync(join(S, 'riser.wav'))) {
  for (const s of ['impact', 'swish', 'shimmer', 'swell', 'pop', 'pad', 'whoosh', 'riser']) {
    const f = s === 'pad' ? 'pad.m4a' : `${s}.wav`; // the pad is long, so it ships compressed
    copyFileSync(join(SOUNDS, f), join(S, f));
  }
}
const lufs = (file) => (spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stderr.match(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold[\s\S]*$/) || [, NaN])[1];

for (const id of process.argv.slice(2)) {
  const A = join(here, 'assets', id);
  const { duration: DUR, cues, musicDb = -20, music } = JSON.parse(readFileSync(join(A, 'cues.json'), 'utf8'));
  ff(['-i', join(A, 'clip.mp4'), '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-ac', '2', join(A, 'voice.wav')]);
  ff(['-ss', String((+id.slice(1) * 11) % 300), '-i', join(S, existsSync(join(S, 'pad.m4a')) ? 'pad.m4a' : 'pad.wav'), '-t', String(DUR), '-af', `afade=t=in:d=1.5,afade=t=out:st=${DUR - 1.5}:d=1.5`, join(A, 'pad.wav')]);
  const snds = [...new Set(cues.map((c) => c.snd))]; // empty when the style's SFX is none
  const inputs = ['-i', join(A, 'voice.wav'), '-i', join(A, 'pad.wav'), ...snds.flatMap((s) => ['-i', join(S, `${s}.wav`)])];
  // the pad sits about musicDb under the voice (0.55 is the approved -20 dB level)
  // music "none" (Simple split): the bed is silenced; the graph keeps its shape
  const parts = ['[0]asplit=2[v][vsc]', `[1]volume=${music === 'none' ? 0 : (0.55 * 10 ** ((musicDb + 20) / 20)).toFixed(3)}[pad]`, '[pad][vsc]sidechaincompress=threshold=0.03:ratio=5:attack=30:release=500[bed]'];
  const labels = ['[v]', '[bed]'];
  snds.forEach((s, si) => {
    const list = cues.filter((c) => c.snd === s);
    parts.push(`[${si + 2}]asplit=${list.length}${list.map((_, k) => `[${s}${k}]`).join('')}`);
    list.forEach((c, k) => { const ms = Math.round(c.t * 1000); parts.push(`[${s}${k}]adelay=${ms}|${ms},volume=${c.gain}[${s}o${k}]`); labels.push(`[${s}o${k}]`); });
  });
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,alimiter=limit=0.7:level=false[out]`);
  writeFileSync(join(A, 'mix-filter.txt'), parts.join(';\n'));
  ff([...inputs, '-/filter_complex', join(A, 'mix-filter.txt'), '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', join(A, 'audio.wav')]);
  console.log(`${id}: ${cues.length} cues, mix ${lufs(join(A, 'audio.wav'))} LUFS`);
}
