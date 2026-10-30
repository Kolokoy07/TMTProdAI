// Builds <id>.html (1080x1920 reel) from reels.json + assets/<id>/transcript.json: the screen recording in
// a liquid-glass window with an auto camera that pans to where the screen is active, settle punches at
// every jump between source sections, the signature hook, a topic chip, transcript-anchored glass cards,
// and one-line per-word animated captions. Writes assets/<id>/cues.json for mix-reel.mjs.
//   node build-reel.mjs r01 [r02 ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REELS = JSON.parse(readFileSync(join(here, 'reels.json'), 'utf8'));
// the chosen Screen-share split style ("style" in source.json, else screen-share-split): colours, fonts,
// captions, screen zoom, card side, chip label, grade, sound; edited in Style Studio
const STYLE = JSON.parse(readFileSync(join(here, '..', '..', '..', 'styles', `${process.env.STYLE || JSON.parse(readFileSync(join(here, 'source.json'), 'utf8')).style || 'screen-share-split'}.json`), 'utf8'));
const SC = STYLE.colours, SF = STYLE.fonts, SL = STYLE.layout;
// layout.simple: the plain version (Simple split): panels edge to edge on a grid with soft glows, the same
// hook as the glass version (with its sounds), captions and screen zooms; no glass, topic chip, cards, or title card
const SIMPLE = !!SL.simple;
// hook.layout "none" (Simple split, no hook): the reel starts straight on the talk, captions from the first word
const NOHOOK = STYLE.hook.layout === 'none';
const rgb = (h) => { const n = parseInt(h.slice(1), 16); return `${n >> 16 & 255},${n >> 8 & 255},${n & 255}`; };
const GLOWHEX = SC.glow || '#2bd46a', GLOW = rgb(GLOWHEX), ACC = rgb(SC.accent);
const GRADES = { natural: 'none', warm: 'sepia(.18) saturate(1.15) hue-rotate(-8deg)', cool: 'saturate(.92) hue-rotate(12deg) brightness(1.03)', bw: 'grayscale(1) contrast(1.12)', 'teal-orange': 'sepia(.12) hue-rotate(-10deg) saturate(1.4) contrast(1.08)' };
const HOOK_END = 4.6, CAP_CHARS = STYLE.captions.maxChars;
// hook motion and sound from the style's Hook tab; HK scales word delays the way Style Studio's preview does
const HOOK_MOTION = STYLE.hook?.motion || 'word-blur-rise', HOOK_SOUND = STYLE.hook?.sound || 'riser-impact';
const HK = { pop: 0.6, 'slide-up': 0.5, typewriter: 0.7 }[HOOK_MOTION] || 1;
// split screen inside the Reels/TikTok safe zone: screen share on top, Coach Tim below, captions on the
// seam, cards over the lower part of his panel; nothing important below y 1530 or right of x 960
const WIN = SIMPLE ? [0, 150, 1080, 780] : [40, 196, 1000, 720], CW = SIMPLE ? 1080 : 980, CH = SIMPLE ? 780 : 700, FW = Math.round(CH * 16 / 9), FH = CH;
const FACEWIN = SIMPLE ? [0, 1040, 1080, 560] : [40, 1040, 1000, 490], FCW = SIMPLE ? 1080 : 980, FCH = SIMPLE ? 560 : 470, FVH = Math.round(2400 * FCW / 1080), FHALF = FVH / 4;
const FACE_Y = { L: -Math.round((FHALF - FCH) * 0.35), R: -Math.round(FHALF + (FHALF - FCH) * 0.35), C: -Math.round(2 * FHALF + (FHALF - FCH) * 0.3), T: -Math.round(3 * FHALF + (FHALF - FCH) * 0.35) };
// where the camera bubble sits in the screen recording (fractions), covered so he never shows twice
const BUBBLE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'source.json'), 'utf8')).bubble
  || { L: [0.006, 0.72, 0.248, 0.964], R: [0.761, 0.742, 1, 0.98], T: [0.012, 0.012, 0.254, 0.255] };
const VIS = CW / FW; // visible share of the footage width at scale 1
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = (x) => (+x).toFixed(3);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9%$/.\- ]/g, '').replace(/\s+/g, ' ').trim();

for (const id of process.argv.slice(2)) {
  const R = REELS.find((r) => r.id === id);
  if (!R) throw new Error(`no reel ${id}`);
  const A = join(here, 'assets', id);
  const T = JSON.parse(readFileSync(join(A, 'transcript.json'), 'utf8'));
  const DUR = +T.audio_duration_secs.toFixed(3);
  // per-reel caption fixes: "from words" (punctuation ignored) -> one replacement word
  const W = T.words.map((w) => ({ ...w }));
  for (const [from, to] of R.fix || []) {
    const seq = norm(from).split(' ');
    for (let i = 0; i + seq.length <= W.length; i++) {
      if (seq.every((s, k) => norm(W[i + k].text).replace(/[.,?!]+$/, '') === s.replace(/[.,?!]+$/, ''))) {
        W.splice(i, seq.length, { text: to, start: W[i].start, end: W[i + seq.length - 1].end });
      }
    }
  }

  // ---- anchors: first occurrence of a phrase at or after a time, matched on the joined caption text
  let joined = '';
  const starts = [];
  W.forEach((w) => { starts.push(joined.length); joined += norm(w.text) + ' '; });
  const at = (phrase, after = 0) => {
    const p = norm(phrase);
    let from = 0;
    while (true) {
      const k = joined.indexOf(p, from);
      if (k < 0) throw new Error(`${id}: phrase "${phrase}" not found after ${after.toFixed(2)}`);
      let wi = starts.findIndex((s, i) => s <= k && (i === starts.length - 1 || starts[i + 1] > k));
      if (W[wi].start >= after - 0.01) return W[wi].start;
      from = k + 1;
    }
  };

  // ---- captions (sentence-aware, one line, max 26 chars)
  const sentences = [];
  let cur = [];
  W.forEach((w, i) => {
    const next = W[i + 1];
    cur.push(w);
    if (/[.?!]$/.test(w.text) || (next && next.start - w.end > 0.32) || !next) { sentences.push(cur); cur = []; }
  });
  const len = (ws) => ws.map((x) => x.text).join(' ').length;
  const groups = [];
  for (const s of sentences) {
    const chunks = [];
    let i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      const n = Math.ceil(len(rest) / CAP_CHARS);
      if (n === 1) { chunks.push(rest); break; }
      const limit = Math.min(CAP_CHARS, len(rest) / n + 3);
      const chunk = [rest[0]];
      while (chunk.length < rest.length && len([...chunk, rest[chunk.length]]) <= limit
        && !(/,$/.test(chunk.at(-1).text) && len(chunk) >= limit * 0.6)) chunk.push(rest[chunk.length]);
      chunks.push(chunk);
      i += chunk.length;
    }
    if (chunks.length > 1 && len(chunks.at(-1)) < 8 && len([...chunks.at(-2), ...chunks.at(-1)]) <= CAP_CHARS) chunks.splice(-2, 2, [...chunks.at(-2), ...chunks.at(-1)]);
    for (const c of chunks) groups.push({ words: c, start: c[0].start, end: c.at(-1).end });
  }
  groups.forEach((g, i) => { if (i) g.start = Math.max(g.start, groups[i - 1].start + 0.1); g.end = Math.max(g.end, g.start + 0.3); });
  groups.forEach((g, i) => { const n = groups[i + 1]; g.end = Math.min(n ? n.start - 0.02 : DUR, g.end + 0.6); });
  const caps = NOHOOK ? groups : groups.filter((g) => g.start >= HOOK_END - 0.05);

  // ---- auto camera: where on screen things change (cursor, typing, scrolling), ignoring pixels that move
  // all the time (the facecam), sampled at 5 fps on a 160x90 copy
  const fr = spawnSync('ffmpeg', ['-v', 'error', '-i', join(A, 'clip.mp4'), '-vf', 'fps=5,scale=160:90,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const PX = 160 * 90, NF = Math.floor(fr.stdout.length / PX);
  const frame = (k) => fr.stdout.subarray(k * PX, (k + 1) * PX);
  const moving = new Uint16Array(PX);
  for (let k = 1; k < NF; k++) { const a = frame(k - 1), b = frame(k); for (let p = 0; p < PX; p++) if (Math.abs(a[p] - b[p]) > 18) moving[p]++; }
  // the screen share sits zoomed in (ZOOM) on where things happen; each new section opens wide, then zooms in
  const ZOOM = SL.screen.zoom, VX = CW / (FW * ZOOM), VY = 1 / ZOOM;
  const act = []; // per sample: { t, x, y, big }
  for (let k = 1; k < NF; k++) {
    const a = frame(k - 1), b = frame(k);
    let n = 0, sx = 0, sy = 0, sw = 0;
    const cols = [];
    for (let p = 0; p < PX; p++) {
      const d = Math.abs(a[p] - b[p]);
      if (d > 18) { n++; if (moving[p] < 0.22 * NF) { sx += (p % 160) * d; sy += Math.floor(p / 160) * d; sw += d; cols.push(p % 160); } }
    }
    let x = sw > 120 ? sx / sw / 160 : null, w = null;
    const y = sw > 120 ? sy / sw / 90 : null;
    if (x !== null && cols.length > 20) {
      cols.sort((p, q) => p - q);
      const lo = cols[Math.floor(cols.length * 0.05)] / 160, hi = cols[Math.floor(cols.length * 0.95)] / 160;
      w = hi - lo;
      // a wide change (a line of text) keeps its left edge in view; a caret or cursor sits right of centre
      x = hi - lo > VX * 0.85 ? lo + VX / 2 - 0.06 : hi - lo < 0.08 ? (lo + hi) / 2 + VX * 0.28 : (lo + hi) / 2;
    }
    act.push({ t: k / 5, x, y, w, big: n > 0.35 * PX });
  }
  const cx = (x, s) => { const v = CW / (FW * s); return Math.min(1 - v / 2, Math.max(v / 2, x)); };
  const cy = (y, s) => { const v = 1 / s; return Math.min(1 - v / 2, Math.max(v / 2, y)); };
  // wide activity (a whole line of text) only zooms in as far as keeps all of it in view
  const zoomFor = (wd) => (wd === null ? ZOOM : Math.min(ZOOM, Math.max(1.1, CW / (FW * (wd + 0.08)))));
  const JOINS = T.joins || [];
  const median = (a) => { const s = a.filter((v) => v !== null).sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : null; };
  // sections: start, every join, and every full-screen change (a new page) at least 3 s after the last
  const secs = [0];
  for (const t of [...JOINS, ...act.filter((a) => a.big).map((a) => a.t)].sort((p, q) => p - q)) if (t - secs.at(-1) > 3 && DUR - t > 2.5) secs.push(+t.toFixed(2));
  const K = []; // [t, dur, x, y, scale, ease, set]
  const camEvents = [];
  secs.forEach((s0, si) => {
    const s1 = secs[si + 1] ?? DUR;
    const zin = si === 0 ? (NOHOOK ? 0.6 : HOOK_END - 0.4) : s0 + 0.9; // the first zoom lands as the hook clears
    if (si) { K.push([s0, 0, 0.5, 0.5, 1.04, 'none', 1]); K.push([s0, 0.45, 0.5, 0.5, 1, 'expo.out']); }
    const win = act.filter((a) => a.t >= zin - 0.2 && a.t < Math.min(s1, zin + 2.5));
    let zt = zoomFor(median(win.map((a) => a.w)));
    let x = cx(median(win.map((a) => a.x)) ?? 0.5, zt), y = cy(median(win.map((a) => a.y)) ?? 0.45, zt);
    if (s1 - zin < 1.2) return;
    K.push([zin, 0.9, x, y, zt, 'power3.inOut']);
    camEvents.push({ t: zin });
    let t0 = zin + 0.9, out = 0, last = zin, z = zt;
    for (const [k, a] of act.entries()) {
      if (a.t < t0 || a.t >= s1 - 0.3) continue;
      const slice = act.slice(Math.max(0, k - 5), k + 1);
      const mx = median(slice.map((q) => q.x)), my = median(slice.map((q) => q.y));
      if (mx === null) { out = 0; continue; }
      const nz = zoomFor(median(slice.map((q) => q.w)));
      const tx = cx(mx, nz), ty = cy(my, nz);
      if (Math.abs(tx - x) > 0.18 || Math.abs(ty - y) > 0.2) out++; else out = 0;
      if (out >= 4 && a.t - last > 2.5) {
        const t = +Math.max(t0, a.t - 0.5).toFixed(2);
        if (t - t0 > 1.5) K.push([t0, t - t0, x, y, zt + 0.04, 'sine.inOut']);
        zt = nz; z = zt; x = tx; y = ty; K.push([t, 0.75, x, y, z, 'power3.inOut']); camEvents.push({ t });
        t0 = t + 0.75; last = a.t; out = 0;
      }
    }
    if (s1 - t0 > 1.5) K.push([t0, s1 - t0, x, y, zt + 0.04, 'sine.inOut']);
  });

  // ---- which corner holds Coach Tim's camera bubble: skin tones in the middle of each corner rect, 2 fps;
  // a switch needs two samples in a row, an empty sample keeps the last corner
  const fs2 = spawnSync('ffmpeg', ['-v', 'error', '-i', join(A, 'clip.mp4'), '-vf', 'fps=2,scale=320:180', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const FS = 320 * 180 * 3, NS = Math.floor(fs2.stdout.length / FS);
  const skin = (r, g, b) => r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 15;
  const corner = [];
  for (let k = 0; k < NS; k++) {
    const fr2 = fs2.stdout.subarray(k * FS, (k + 1) * FS), sc = {};
    for (const [c, [x0, y0, x1, y1]] of Object.entries(BUBBLE)) {
      let n = 0, s = 0;
      for (let y = Math.floor((y0 + (y1 - y0) * 0.15) * 180); y < (y0 + (y1 - y0) * 0.8) * 180; y++)
        for (let x = Math.floor((x0 + (x1 - x0) * 0.3) * 320); x < (x0 + (x1 - x0) * 0.7) * 320; x++) { const p = (y * 320 + x) * 3; n++; if (skin(fr2[p], fr2[p + 1], fr2[p + 2])) s++; }
      sc[c] = s / n;
    }
    let mid = 0, mn = 0;
    for (let y = 36; y < 108; y++) for (let x = 112; x < 208; x++) { const p = (y * 320 + x) * 3; mn++; if (skin(fr2[p], fr2[p + 1], fr2[p + 2])) mid++; }
    const best = Object.keys(sc).reduce((p, q) => (sc[p] >= sc[q] ? p : q));
    // the centre of the screen recording is never skin-coloured, so skin there means a full-screen camera shot
    // ...together with his dark green wall down the left side (light TradingView charts have skin-like pinks)
    let wall = 0, wn = 0;
    for (let y = 18; y < 162; y += 2) for (let x = 0; x < 56; x += 2) { const q = (y * 320 + x) * 3, r = fr2[q], g = fr2[q + 1], bl = fr2[q + 2]; wn++; if (g > r && g >= bl && g > 25 && g < 120) wall++; }
    corner.push(mid / mn > 0.1 && wall / wn > 0.35 ? 'C' : sc[best] > 0.06 ? best : null);
  }
  const SIDE = []; // [t, corner]
  let side = corner.find((c) => c) || 'R';
  SIDE.push([0, side]);
  for (let k = 1; k < corner.length; k++) {
    if (corner[k] && corner[k] !== side && corner[k - 1] === corner[k]) { side = corner[k]; SIDE.push([+((k - 1) / 2).toFixed(2), side]); }
  }

  // ---- cards (each stays until the next one, at least 3.5 s, at most 10 s)
  const cards = [];
  let after = HOOK_END - 0.3;
  for (const c of R.cards) {
    const s0 = Math.max(at(c.at, after) - 0.15, HOOK_END + 0.1);
    const rows = (c.rows || []).map(([p, text]) => ({ t: Math.max(s0 + 0.25, at(p, s0 - 0.5) - 0.05), text }));
    for (let i = 1; i < rows.length; i++) rows[i].t = Math.max(rows[i].t, rows[i - 1].t + 0.25);
    cards.push({ ...c, s: s0, rows });
    after = s0 + 1;
  }
  cards.forEach((c, i) => {
    const n = cards[i + 1];
    const lastRow = c.rows.length ? c.rows.at(-1).t : c.s;
    // a card stays until its last row has shown for 3 s (a big-word card: at most 10 s), or the next card
    c.e = Math.min(n ? n.s - 0.1 : DUR - 0.05, Math.max(c.s + 3.5, lastRow + 3), c.rows.length ? Infinity : c.s + 10, DUR - 0.05);
    if (c.e - c.s < 1.5) throw new Error(`${id}: card "${c.at}" too short`);
  });

  // ---- sound cues for mix-reel.mjs
  const hookWords = R.hook.map((h) => h.split(' ').length);
  const hookSound = HOOK_SOUND === 'riser-impact' ? [{ t: 0, snd: 'riser', gain: 0.2, len: HOOK_END - 0.05 }, { t: HOOK_END - 0.05, snd: 'impact', gain: 0.42 }]
    : HOOK_SOUND === 'hit' ? [{ t: 0, snd: 'impact', gain: 0.42 }] : [];
  const cues = [
    ...hookSound,
    ...JOINS.map((j) => ({ t: Math.max(0, j - 0.08), snd: 'whoosh', gain: 0.15 })),
    ...camEvents.map((e) => ({ t: e.t, snd: 'whoosh', gain: 0.07 })),
    ...cards.flatMap((c) => [{ t: c.s, snd: 'swell', gain: 0.13 }, ...(c.b ? [{ t: c.s + 0.45, snd: 'shimmer', gain: 0.09 }] : []), ...c.rows.map((r) => ({ t: r.t + 0.05, snd: 'pop', gain: 0.15 }))]),
  ];
  const HOOK_SPEC = [[0.05, 0.16], [0.4, 0.14], [0.85, 0.06]];
  HOOK_SPEC.forEach(([d, st], li) => { for (let k = 0; k < hookWords[li]; k++) cues.push({ t: (d + k * st) * HK + 0.06, snd: li === 1 ? 'shimmer' : 'swish', gain: +((li === 2 ? 0.05 : li === 1 ? 0.09 : 0.12) * (k % 2 ? 0.85 : 1)).toFixed(3) }); });
  writeFileSync(join(A, 'cues.json'), JSON.stringify({ duration: DUR, musicDb: STYLE.extras.musicDb, music: STYLE.extras.music, cues: SIMPLE ? (STYLE.hook.sound === 'none' || NOHOOK ? [] : cues.filter((c) => ['riser', 'impact'].includes(c.snd) || (['swish', 'shimmer'].includes(c.snd) && c.t < HOOK_END))) : STYLE.extras.sfx === 'none' ? [] : cues.sort((a, b) => a.t - b.t) }, null, 1));

  // ---- html
  const words = (s) => s.split(' ').map((w) => `<span class="w">${esc(w)}</span>`).join(' ');
  const rich = (s) => esc(s).replace(/\*(.+?)\*/g, '<i>$1</i>');
  const fit = (text, maxPx, perChar, lo, hi) => Math.round(Math.max(lo, Math.min(hi, maxPx / (text.length * perChar))));
  const balance = (s) => { // two balanced lines for long heavy text
    if (s.length <= 10 || !s.includes(' ')) return [s];
    const ws = s.split(' ');
    let best = [s], bestW = Infinity;
    for (let k = 1; k < ws.length; k++) { const a = ws.slice(0, k).join(' '), b = ws.slice(k).join(' '); const m = Math.max(a.length, b.length); if (m < bestW) { bestW = m; best = [a, b]; } }
    return best;
  };
  const [hb, hi, hs] = R.hook;
  const hbLines = balance(hb), hbSize = fit(hbLines.reduce((a, b) => (a.length > b.length ? a : b)), 940, 0.64, 110, 250);
  const hiSize = fit(hi, 1000, 0.4, 84, 150);
  const check = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const spark = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z" fill="currentColor"/></svg>';
  const cardEls = cards.map((c, i) => {
    const head = `<div class="eyebrow"><span class="ic">${spark}</span>${esc(c.eyebrow)}</div>`;
    let body = '';
    if (c.rows.length) body = `<div class="rows">` + c.rows.map((r, k) => `<div class="row" id="card${i}r${k}"><span class="tick">${check}</span><span>${rich(r.text)}</span></div>`).join('') + '</div>';
    else {
      const bl = balance(c.b), bs = fit(bl.reduce((a, b) => (a.length > b.length ? a : b)), 278, 0.58, 34, 70);
      body = `<div class="t"><b style="font-size:${bs}px">${bl.map(words).join('<br>')}</b><i style="font-size:${fit(c.i, 278, 0.42, 26, 46)}px">${words(c.i)}</i></div>`
        + (c.chips ? `<div class="chips">${c.chips.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : '');
    }
    return `<div id="card${i}" class="card glass clip" data-start="${f(c.s)}" data-duration="${f(c.e - c.s)}" data-track-index="${4 + (i % 2)}"><div class="sheen"></div>${head}${body}</div>`;
  }).join('\n');
  const capEls = caps.map((g, i) => `<div id="cg-${i}" class="cap clip" data-start="${f(g.start)}" data-duration="${f(g.end - g.start)}" data-track-index="${8 + (i % 2)}"><span class="line">${g.words.map((w) => `<span class="cw">${esc(w.text)}</span>`).join(' ')}</span></div>`).join('\n');

  const html = `<!doctype html>
<html lang="tl"><head><meta charset="utf-8"><title>${esc(R.title)} — Mate Portal</title>
<script src="assets/gsap.min.js"></script>
<style>
*{box-sizing:border-box}html,body{margin:0;width:1080px;height:1920px;overflow:hidden;background:#06070a}
#main{position:relative;width:1080px;height:1920px;overflow:hidden;background:#06070a;font-family:'${SF.body.family}',Inter,Arial,sans-serif;color:#fff}
.glow{position:absolute;border-radius:50%;filter:blur(90px)}
#g1{width:900px;height:700px;left:-300px;top:-200px;background:radial-gradient(circle,rgba(${GLOW},.55),rgba(${GLOW},0) 70%)}
#g2{width:900px;height:760px;right:-360px;bottom:-200px;background:radial-gradient(circle,rgba(${ACC},.38),rgba(${ACC},0) 70%)}
#g3{width:700px;height:500px;left:100px;top:1100px;background:radial-gradient(circle,rgba(70,120,255,.22),rgba(70,120,255,0) 70%)}
#grid{position:absolute;inset:0;opacity:.18;background-image:linear-gradient(rgba(255,255,255,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.18) 1px,transparent 1px);background-size:64px 64px;
  -webkit-mask-image:radial-gradient(ellipse at center,transparent 35%,#000 75%);mask-image:radial-gradient(ellipse at center,transparent 35%,#000 75%)}
.glass{background:linear-gradient(145deg,rgba(255,255,255,.16),rgba(255,255,255,.04) 45%,rgba(255,255,255,.08));
  -webkit-backdrop-filter:blur(26px) saturate(185%);backdrop-filter:blur(26px) saturate(185%);border:1px solid rgba(255,255,255,.22);
  box-shadow:inset 0 1.5px 0 rgba(255,255,255,.45),inset 0 -1px 0 rgba(255,255,255,.08),inset 0 0 30px rgba(255,255,255,.05),0 30px 80px rgba(0,0,0,.55);position:relative;overflow:hidden}
.sheen{position:absolute;top:-20%;bottom:-20%;width:38%;left:-60%;transform:skewX(-18deg);pointer-events:none;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.28),rgba(255,255,255,0))}
#stage{position:absolute;inset:0;perspective:1800px}
#win{position:absolute;left:${WIN[0]}px;top:${WIN[1]}px;width:${WIN[2]}px;height:${WIN[3]}px;border-radius:30px;padding:10px;transform-origin:50% 55%;
  box-shadow:inset 0 1.5px 0 rgba(255,255,255,.45),0 40px 120px rgba(0,0,0,.7),0 0 140px rgba(${GLOW},.16)}
#clipbox{position:relative;width:${CW}px;height:${CH}px;border-radius:21px;overflow:hidden;background:#000}
#zoom{position:absolute;left:0;top:0;width:${FW}px;height:${FH}px;transform-origin:0 0}
#zoom video{width:${FW}px;height:${FH}px;display:block;object-fit:cover;filter:${GRADES[STYLE.visuals.grade] || 'none'}}
#dim,#fdim{position:absolute;inset:0;background:#06070a;opacity:0}
#cover{position:absolute;inset:0;opacity:0;display:flex;align-items:center;justify-content:center;padding:0 60px;
  background:radial-gradient(ellipse at 30% 20%,rgba(${GLOW},.28),transparent 60%),radial-gradient(ellipse at 80% 90%,rgba(${ACC},.2),transparent 60%),#07090a}
#cover .clab{font-weight:800;font-size:18px;letter-spacing:5px;color:rgba(255,255,255,.6);text-transform:uppercase;margin-bottom:18px}
#face{position:absolute;left:${FACEWIN[0]}px;top:${FACEWIN[1]}px;width:${FACEWIN[2]}px;height:${FACEWIN[3]}px;border-radius:30px;padding:10px;transform-origin:50% 40%;
  box-shadow:inset 0 1.5px 0 rgba(255,255,255,.45),0 40px 120px rgba(0,0,0,.7),0 0 120px rgba(${ACC},.12)}
#fbox{position:relative;width:${FCW}px;height:${FCH}px;border-radius:21px;overflow:hidden;background:#000}
#fcam{position:absolute;left:0;top:0;width:${FCW}px;height:${FVH}px;transform-origin:50% 25%}
#fcam video{width:${FCW}px;height:${FVH}px;display:block}
.bub{position:absolute;border-radius:18px;opacity:0;background:linear-gradient(160deg,#121715,#0a0d0c);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
#hook{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:30;padding:0 40px;
  background:linear-gradient(180deg,rgba(6,7,10,0) 10%,rgba(6,7,10,.62) 32%,rgba(6,7,10,.72) 50%,rgba(6,7,10,.62) 68%,rgba(6,7,10,0) 90%)}
.t{display:flex;flex-direction:column;align-items:center;text-align:center}
.t b{font-family:'${SF.headline.family}',Inter,sans-serif;font-weight:${SF.headline.weight};letter-spacing:-.04em;line-height:.92;filter:drop-shadow(0 8px 22px rgba(0,0,0,.6))}
.t .w{display:inline-block;will-change:transform,filter,opacity}
.t b .w{background:linear-gradient(180deg,${SC.primary} 0%,${SC.primary} 42%,${SC.primaryEnd} 100%);-webkit-background-clip:text;background-clip:text;color:transparent;padding:0 .03em}
.t i{font-family:'${SF.accent.family}',Georgia,serif;font-style:${SF.accent.italic ? 'italic' : 'normal'};font-weight:400;line-height:.9;color:${SC.accent};margin-top:-.22em;letter-spacing:-1px;filter:drop-shadow(0 6px 18px rgba(0,0,0,.65))}
.t small{font-weight:800;font-size:40px;color:#fff;margin-top:30px;letter-spacing:.3px;max-width:860px;line-height:1.25;filter:drop-shadow(0 3px 10px rgba(0,0,0,.8))}
#topic{position:absolute;left:66px;top:1066px;z-index:21;border-radius:999px;padding:12px 24px 12px 18px;display:flex;align-items:center;gap:12px;opacity:0}
#topic .dot{width:12px;height:12px;border-radius:50%;background:${GLOWHEX};box-shadow:0 0 14px ${GLOWHEX}}
#topic .lab{font-weight:800;font-size:13px;letter-spacing:3px;color:rgba(255,255,255,.62);text-transform:uppercase}
#topic .val{font-weight:900;font-size:24px;letter-spacing:-.5px}
/* cards: compact, in the empty space left of Coach Tim, under the topic label */
.card{position:absolute;left:${SL.cards.side === 'right' ? 642 : 62}px;width:318px;top:1132px;z-index:20;border-radius:22px;padding:16px 20px 18px;opacity:0}
.eyebrow{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px;letter-spacing:3px;color:rgba(255,255,255,.72);text-transform:uppercase}
.eyebrow .ic{color:${SC.accent};display:flex;filter:drop-shadow(0 0 10px rgba(${ACC},.6))}
.row{display:flex;align-items:center;gap:10px;margin-top:9px;font-weight:800;font-size:23px;letter-spacing:-.6px;line-height:1.12;opacity:0}
.row i{font-family:'${SF.accent.family}',Georgia,serif;font-weight:400;font-size:28px;color:${SC.accent};letter-spacing:0}
.tick{flex:none;width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center;color:#06140c;
  background:linear-gradient(160deg,#6ff0a6,#22c46a);box-shadow:0 6px 18px rgba(34,196,106,.45),inset 0 1px 0 rgba(255,255,255,.6)}
.card .t{align-items:flex-start;text-align:left;margin-top:14px}
.card .t b{letter-spacing:-.04em}
.card .t i{margin-top:-.12em;margin-left:6px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.chips span{font-weight:800;font-size:14px;letter-spacing:.5px;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18)}
.cap{position:absolute;left:0;right:0;top:918px;height:122px;display:flex;align-items:center;justify-content:center;opacity:0;z-index:25}
.cap .line{white-space:nowrap;text-align:center;font-family:'${SF.caption.family}',Inter,sans-serif;font-weight:${SF.caption.weight};font-size:${STYLE.captions.size}px;color:${SC.caption};line-height:1.15;letter-spacing:-.5px;
  -webkit-text-stroke:2px rgba(0,0,0,.85);paint-order:stroke fill;text-shadow:0 3px 0 rgba(0,0,0,.55),0 0 18px rgba(0,0,0,.75),0 0 4px rgba(0,0,0,.9)}
.cap .cw{display:inline-block;opacity:0;will-change:transform,filter,opacity}
${SIMPLE ? `/* Simple split overrides */
#topic,.card,#cover,.sheen{display:none!important}${NOHOOK ? ' #hook{display:none!important} #dim,#fdim{opacity:0!important}' : ''}
/* the same slow-drifting blurred colour glows as the glass version, softer */
.glow{opacity:.6}
html,body,#main{background:#000!important}
/* faint grid over the whole black background, slowly drifting (the panels sit on top of it) */
#grid{opacity:.5!important;-webkit-mask-image:none!important;mask-image:none!important}
#win,#face{padding:0!important;border:0!important;border-radius:0!important;background:none!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;transform:none!important;opacity:1!important}
#clipbox,#fbox{border-radius:0!important}
.bub{border-radius:0!important;background:#000!important;box-shadow:none!important}
.cap{top:${WIN[1] + WIN[3]}px!important;height:${FACEWIN[1] - WIN[1] - WIN[3]}px!important}` : ''}
</style></head><body>
<div id="main" data-composition-id="main" data-start="0" data-duration="${f(DUR)}" data-width="1080" data-height="1920">
<div id="g1" class="glow"></div><div id="g2" class="glow"></div><div id="g3" class="glow"></div><div id="grid"></div>
<div id="stage"><div id="win" class="glass"><div class="sheen" id="winsheen"></div><div id="clipbox"><div id="zoom">
<video id="v" src="assets/${id}/clip.mp4" data-start="0" data-duration="${f(DUR)}" data-track-index="0" muted playsinline></video>
${Object.entries(BUBBLE).map(([c, [x0, y0, x1, y1]]) => `<div id="bub${c}" class="bub" style="left:${Math.round(x0 * FW)}px;top:${Math.round(y0 * FH)}px;width:${Math.round((x1 - x0) * FW)}px;height:${Math.round((y1 - y0) * FH)}px"></div>`).join('')}
</div><div id="cover"><div class="t"><span class="clab">${esc(SL.chipLabel ?? 'Mate Portal')}</span><b style="font-size:${fit(R.title, 820, 0.56, 60, 120)}px">${words(R.title)}</b><i style="font-size:${fit(R.hook[1], 820, 0.4, 44, 84)}px">${words(R.hook[1])}</i></div></div><div id="dim"></div></div></div>
<div id="face" class="glass"><div class="sheen" id="facesheen"></div><div id="fbox"><div id="fcam">
<video id="fv" src="assets/${id}/face.mp4" data-start="0" data-duration="${f(DUR)}" data-track-index="10" muted playsinline></video>
</div><div id="fdim"></div></div></div></div>
<audio id="a" src="assets/${id}/audio.wav" data-start="0" data-duration="${f(DUR)}" data-track-index="1" data-volume="1"></audio>
<div id="hook" class="clip" data-start="0" data-duration="${f(HOOK_END)}" data-track-index="2">
<div class="t"><b style="font-size:${hbSize}px">${hbLines.map(words).join('<br>')}</b><i style="font-size:${hiSize}px">${words(hi)}</i><small>${words(hs)}</small></div></div>
<div id="topic" class="glass clip" data-start="${f(HOOK_END - 0.2)}" data-duration="${f(DUR - HOOK_END + 0.2)}" data-track-index="3"><div class="sheen"></div>
<span class="dot"></span><div><div class="lab">${esc(SL.chipLabel ?? 'Mate Portal')}</div><div class="val">${esc(R.title)}</div></div></div>
${cardEls}
${capEls}
</div>
<script>
const tl = gsap.timeline({ paused: true });
const D = ${f(DUR)}, HOOK_END = ${HOOK_END}, CW = ${CW}, CH = ${CH}, FW = ${FW}, FH = ${FH};
tl.to('#g1', { x: 220, y: 160, duration: D, ease: 'sine.inOut' }, 0);
tl.to('#g2', { x: -260, y: -140, duration: D, ease: 'sine.inOut' }, 0);
tl.to('#g3', { x: 300, y: -200, duration: D, ease: 'sine.inOut' }, 0);
tl.fromTo('#grid', { backgroundPosition: '0px 0px' }, { backgroundPosition: '64px 96px', duration: D, ease: 'none' }, 0);
tl.fromTo('#win', { opacity: 0, y: 110, scale: 0.9, rotationX: 16 }, { opacity: 1, y: 0, scale: 1, rotationX: 0, duration: 1.6, ease: 'expo.out' }, 0);
tl.fromTo('#face', { opacity: 0, y: 140, scale: 0.9, rotationX: -14 }, { opacity: 1, y: 0, scale: 1, rotationX: 0, duration: 1.6, ease: 'expo.out' }, 0.15);
tl.fromTo('#dim,#fdim', { opacity: 0.45 }, { opacity: 0, duration: 0.7, ease: 'power2.out' }, HOOK_END - 0.25);
tl.fromTo('#facesheen', { x: 0 }, { x: 2200, duration: 1.3, ease: 'power2.inOut' }, HOOK_END);
// Coach Tim: show the corner that holds his bubble, cover that bubble in the screen share
const SIDE = ${JSON.stringify(SIDE)}, FACE_Y = ${JSON.stringify(FACE_Y)};
SIDE.forEach(([t, c]) => { tl.set('#fv', { y: FACE_Y[c] }, t); tl.set('#bubL', { opacity: c === 'L' ? 1 : 0 }, t); tl.set('#bubR', { opacity: c === 'R' ? 1 : 0 }, t); tl.set('#bubT', { opacity: c === 'T' ? 1 : 0 }, t); tl.to('#cover', { opacity: c === 'C' ? 1 : 0, duration: 0.35, ease: 'power2.inOut' }, t); });
tl.fromTo('#fcam', { scale: 1 }, { scale: 1.05, duration: D, ease: 'sine.inOut' }, 0);
tl.fromTo('#winsheen', { x: 0 }, { x: 2200, duration: 1.3, ease: 'power2.inOut' }, HOOK_END - 0.2);
// camera (auto: follows screen activity)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cam = (x, y, s) => ({ scale: s, x: clamp(CW / 2 - x * FW * s, CW - FW * s, 0), y: clamp(CH / 2 - y * FH * s, CH - FH * s, 0) });
const K = ${JSON.stringify(K.map((k) => k.map((v) => (typeof v === 'number' ? +v.toFixed(3) : v))))};
tl.set('#zoom', cam(0.5, 0.5, 1), 0);
K.forEach(([t, d, x, y, s, ease, set]) => { if (set) tl.set('#zoom', cam(x, y, s), t); else tl.to('#zoom', { ...cam(x, y, s), duration: d, ease }, t); });
${JSON.stringify(JOINS)}.forEach((t) => tl.fromTo('#win,#face', { scale: 0.985 }, { scale: 1, duration: 0.5, ease: 'expo.out' }, t));
function wordsIn(sel, s, y, blur, stagger, dur) {
  const els = document.querySelectorAll(sel);
  if (els.length) tl.fromTo(els, { opacity: 0, y, filter: 'blur(' + blur + 'px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: dur, ease: 'expo.out', stagger }, s);
}
// hook words build in with the style's motion (blur rise, pop, slide up, typewriter, or soft fade)
const HOOK_MOTION = '${HOOK_MOTION}', HK = ${HK};
function hookIn(sel, s, y, blur, stagger) {
  const els = document.querySelectorAll(sel), at = s * HK, st = stagger * HK;
  if (!els.length) return;
  if (HOOK_MOTION === 'pop') tl.fromTo(els, { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1, duration: 0.52, ease: 'back.out(1.7)', stagger: st }, at);
  else if (HOOK_MOTION === 'slide-up') tl.fromTo(els, { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.65, ease: 'power3.out', stagger: st }, at);
  else if (HOOK_MOTION === 'typewriter') tl.fromTo(els, { opacity: 0, clipPath: 'inset(0% 100% 0% 0%)' }, { opacity: 1, clipPath: 'inset(0% 0% 0% 0%)', duration: 0.26, ease: 'steps(6)', stagger: st }, at);
  else if (HOOK_MOTION === 'fade') tl.fromTo(els, { opacity: 0 }, { opacity: 1, duration: 1.4, ease: 'expo.out', stagger: st }, at);
  else wordsIn(sel, at, y, blur, st, 1.4);
}
hookIn('#hook b .w', 0.05, 70, 18, 0.16);
hookIn('#hook i .w', 0.4, 40, 12, 0.14);
hookIn('#hook small .w', 0.85, 20, 8, 0.06);
tl.to('#hook .w', { opacity: 0, y: -24, filter: 'blur(10px)', duration: 0.42, ease: 'power2.in', stagger: 0.015 }, HOOK_END - 0.6);
tl.to('#hook', { opacity: 0, duration: 0.27, ease: 'power2.in' }, HOOK_END - 0.27);
tl.fromTo('#topic', { opacity: 0, y: -20, filter: 'blur(12px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.9, ease: 'expo.out' }, HOOK_END - 0.1);
tl.fromTo('#topic .sheen', { x: 0 }, { x: 600, duration: 1.1, ease: 'power2.inOut' }, HOOK_END + 0.1);
const CARDS = ${JSON.stringify(cards.map((c) => [+f(c.s), +f(c.e), c.rows.map((r) => +f(r.t))]))};
CARDS.forEach(([s, e, rows], i) => {
  const id = '#card' + i;
  tl.fromTo(id, { opacity: 0, y: 50, scale: 0.95, filter: 'blur(14px)' }, { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.9, ease: 'expo.out' }, s);
  tl.fromTo(id + ' .sheen', { x: 0 }, { x: 1500, duration: 1.1, ease: 'power2.inOut' }, s + 0.15);
  wordsIn(id + ' b .w', s + 0.15, 40, 12, 0.12, 1.1);
  wordsIn(id + ' i .w', s + 0.45, 30, 10, 0.1, 1.1);
  wordsIn(id + ' .chips span', s + 0.8, 12, 4, 0.08, 0.6);
  rows.forEach((t, k) => {
    tl.fromTo(id + 'r' + k, { opacity: 0, x: -24, filter: 'blur(8px)' }, { opacity: 1, x: 0, filter: 'blur(0px)', duration: 0.7, ease: 'expo.out' }, t);
    tl.fromTo(id + 'r' + k + ' .tick', { scale: 0.4, rotation: -20 }, { scale: 1, rotation: 0, duration: 0.6, ease: 'back.out(2.4)' }, t + 0.05);
  });
  tl.to(id, { opacity: 0, y: 20, filter: 'blur(12px)', scale: 0.97, duration: 0.4, ease: 'power2.in' }, e - 0.4);
});
const CAPS = ${JSON.stringify(caps.map((g) => [+f(g.start), +f(g.end), g.words.map((w) => +f(Math.max(g.start, w.start)))]))};
CAPS.forEach(([s, e, ws], i) => {
  const el = '#cg-' + i;
  tl.set(el, { opacity: 1 }, s);
  document.querySelectorAll(el + ' .cw').forEach((w, k) => {
    tl.fromTo(w, { opacity: 0, y: 16, filter: 'blur(6px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.28, ease: 'power3.out' }, Math.min(ws[k], e - 0.15));
  });
  tl.to(el, { opacity: 0, duration: 0.1, ease: 'power2.in' }, Math.max(s + 0.12, e - 0.1));
  tl.set(el, { opacity: 0 }, e);
});
window.__timelines = window.__timelines || {};
window.__timelines['main'] = tl;
</script></body></html>
`;
  writeFileSync(join(here, `${id}.html`), html);
  console.log(`${id}: ${DUR.toFixed(1)} s, ${caps.length} captions, ${cards.length} cards at ${cards.map((c) => c.s.toFixed(1)).join('/')}, ${camEvents.length} pans, ${JOINS.length} joins`);
}
