#!/usr/bin/env node
// Style Studio: a local page for building named short-form styles (colours, fonts, hook, captions,
// visuals, extras) on frames of your own footage. Saves to styles/<slug>.json plus a readable
// styles/<slug>.md that the TMTProdAI skill reads when editing.
//
//   node tools/style-studio/server.mjs        then open http://localhost:4747
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const stylesDir = join(root, 'styles');
const cacheDir = join(stylesDir, '.cache');
const PORT = Number(process.env.PORT) || 4747;
mkdirSync(cacheDir, { recursive: true });

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;

// Preview frames come from clean footage with no burned-in text: the newest raw video in inbox/,
// else the newest edited clean cut in kit/video-projects/*/assets/, else a render in outbox/.
// They are extracted once into styles/.cache so personal footage never lands in git.
function newest(paths) {
  return paths.filter((f) => existsSync(f)).map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f || null;
}
const videosIn = (d) => (existsSync(d) ? readdirSync(d).filter((f) => VIDEO.test(f) && f !== 'setup-test.mp4').map((f) => join(d, f)) : []);
function newestVideo() {
  const projects = join(root, 'kit', 'video-projects');
  const cleanCuts = existsSync(projects) ? readdirSync(projects).map((p) => join(projects, p, 'assets', 'edited-clean.mp4')) : [];
  return newest(videosIn(join(root, 'inbox'))) || newest(cleanCuts) || newest(videosIn(join(root, 'outbox')));
}
function frames(refresh = false) {
  const have = readdirSync(cacheDir).filter((f) => /^frame-\d\.jpg$/.test(f)).sort();
  if (have.length && !refresh) return have;
  const src = newestVideo();
  if (!src) return [];
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { encoding: 'utf8' });
  const dur = Number(probe.stdout) || 60;
  const out = [];
  [0.16, 0.38, 0.6, 0.82].forEach((p, i) => {
    const name = `frame-${i}.jpg`;
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(dur * p), '-i', src, '-frames:v', '1',
      '-vf', 'scale=540:960:force_original_aspect_ratio=increase,crop=540:960', '-q:v', '4', join(cacheDir, name)]);
    if (r.status === 0) out.push(name);
  });
  return out;
}

// Screen-share split previews: a screen frame and the speaker's camera bubble from the newest project made
// with that format (one with source.json and reel clips). The bubble corner is the one with skin tones.
const SPLIT = ['split-screen.jpg', 'split-face.jpg'];
const BUBBLES = [[0.773, 0.752, 0.219, 0.216], [0.017, 0.735, 0.219, 0.216], [0.023, 0.025, 0.219, 0.216]];
function splitFrames(refresh = false) {
  if (!refresh && SPLIT.every((n) => existsSync(join(cacheDir, n)))) return SPLIT;
  const projects = join(root, 'kit', 'video-projects');
  const proj = existsSync(projects) ? newest(readdirSync(projects).map((p) => join(projects, p, 'source.json'))) : null;
  if (!proj) return [];
  const assets = join(dirname(proj), 'assets');
  const clips = readdirSync(assets).filter((d) => /^r\d+$/.test(d)).map((d) => join(assets, d, 'clip.mp4')).filter(existsSync);
  for (const clip of clips) {
    const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip], { encoding: 'utf8' }).stdout) || 30;
    for (const at of [0.3, 0.55, 0.8]) {
      for (const [x, y, w, h] of BUBBLES) {
        const crop = `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`;
        const raw = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(dur * at), '-i', clip, '-frames:v', '1', '-vf', `${crop},scale=32:18`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 }).stdout;
        let skin = 0;
        for (let i = 0; i < raw.length; i += 3) {
          const r = raw[i], g = raw[i + 1], b = raw[i + 2];
          if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 15) skin++;
        }
        if (!raw.length || skin / (raw.length / 3) < 0.1) continue;
        spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(dur * at), '-i', clip, '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '3', join(cacheDir, SPLIT[0])]);
        spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(dur * at), '-i', clip, '-frames:v', '1', '-vf', `${crop},scale=980:-2`, '-q:v', '3', join(cacheDir, SPLIT[1])]);
        return SPLIT;
      }
    }
  }
  return [];
}

const listStyles = () => (existsSync(stylesDir) ? readdirSync(stylesDir) : [])
  .filter((f) => f.endsWith('.json')).map((f) => {
    try { const s = JSON.parse(readFileSync(join(stylesDir, f), 'utf8')); return { slug: s.slug, name: s.name, updated: s.updated, format: s.layout ? 'split' : 'reels' }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
const defaultSlug = () => { try { return readFileSync(join(stylesDir, 'DEFAULT'), 'utf8').trim(); } catch { return null; } };

// The .md is what the editor reads: plain bullets with the exact values to apply.
function toMarkdown(s) {
  if (s.layout) return splitMarkdown(s);
  const c = s.colours, f = s.fonts, h = s.hook, k = s.captions, v = s.visuals, x = s.extras;
  return `# Style: ${s.name}

Saved from Style Studio ${s.updated}. Machine-readable values: \`styles/${s.slug}.json\`.

- Format: ${s.format}
- Colours (${c.id}): headline gradient ${c.primary} to ${c.primaryEnd}, accent ${c.accent}, captions ${c.caption}, shade ${c.shade}
- Fonts (${f.id}): headline ${f.headline.family} ${f.headline.weight}${f.headline.upper ? ' UPPERCASE' : ''}, tracking ${f.headline.tracking}em; accent ${f.accent.family} ${f.accent.italic ? 'italic ' : ''}${f.accent.weight}; small line ${f.body.family} ${f.body.weight}; captions ${f.caption.family} ${f.caption.weight}
- Hook: ${h.layout === 'none' ? 'none, no hook text; start straight into the video' : `${h.layout} layout, ${h.motion} motion, on screen ${h.minSeconds}-${h.maxSeconds} s${h.avoidAction ? ', ends early if it would cover action' : ''}; sound ${h.sound}`}
- Captions: ${k.style === 'none' ? 'none' : `${k.style}, max ${k.maxChars} characters, one line${k.highlight ? ', key word in accent' : ''}, ${k.position} (y ${k.y}), ${k.size}px${k.box ? ', dark box' : ', stroke + shadow'}`}
- Titles: ${v.titleLayout === 'none' ? 'none, no section titles or cards' : `${v.titleLayout}, backing ${v.backing}, ${v.motion} motion, fully on screen at least ${v.titleMinHold} s (+0.3 s per word past 3)`}
- Look: grade ${v.grade}, pace ${v.pace}, punch-in zooms ${v.punchIns}
- Sound: ${x.sfx === 'none' ? 'no sound effects' : `SFX ${x.sfx}`}; ${x.music === 'none' ? 'no music, voice only' : `music ${x.music} about ${Math.abs(x.musicDb)} dB under the voice, ducked under speech`}
- CTA: ${x.ctaKeyword ? `keyword "${x.ctaKeyword}"${x.ctaPops ? ', pop on each spoken keyword' : ''}` : 'none'}
${s.note ? `\n${s.note}\n` : ''}`;
}

// Screen-share split: the layout values the format's build-reel.mjs reads, in plain words
function splitMarkdown(s) {
  const c = s.colours, f = s.fonts, k = s.captions, L = s.layout, x = s.extras;
  return `# Style: ${s.name}

Saved from Style Studio ${s.updated}. Machine-readable values: \`styles/${s.slug}.json\`. Scripts and sounds:
\`styles/screen-share-split/\` (see its README).

Use for: ${s.use || 'screen recordings with the speaker in a camera bubble, cut into educational reels'}.
Talking-head reels use a Reels-format style instead.

- Format: ${s.format}, split screen. Screen share on top, the speaker always in the bottom panel,
  captions on the seam between them; every graphic inside the Reels/TikTok safe zone.
- Speaker panel: the camera bubble cropped from the 4K recording, following it to whichever corner it
  is in; full-screen camera shots show the speaker centred below and a glass title card on top.
- Screen share: zoomed about ${L.screen.zoom}x on where things happen, moving only when the action moves;
  each new section opens wide, then zooms in.
- Topic chip: "${L.chipLabel || 'Mate Portal'} / <topic>" in the speaker panel's top-left corner
- Cards: small glass cards on the ${L.cards.side || 'left'} of the speaker, anchored to the words they explain
- Colours (${c.id}): headline gradient ${c.primary} to ${c.primaryEnd}, accent ${c.accent}, captions ${c.caption}, shade ${c.shade}, glass glow ${c.glow || '#2bd46a'}
- Fonts (${f.id}): headline ${f.headline.family} ${f.headline.weight}; accent ${f.accent.family}${f.accent.italic ? ' italic' : ''}; captions ${f.caption.family} ${f.caption.weight}
- Hook: 4.6 s, ${s.hook.motion}, heavy word + accent line + small question line; sound ${s.hook.sound}
- Captions: one line, max ${k.maxChars} characters, ${k.size}px, words rise out of a blur as spoken
- Look: liquid glass panels over drifting glows, ${s.visuals.grade} grade, ${s.visuals.pace} cuts, no speed-ups
- Sound: SFX ${x.sfx}; ambient pad about ${Math.abs(x.musicDb)} dB under the voice, ducked under speech
- Reels: at least ${s.reels?.minSeconds || 40} s each, one topic per reel, lines may be reordered so it flows;
  show the topic list before cutting
`;
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const readBody = (req) => new Promise((ok, bad) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 1e6) bad(new Error('too large')); });
  req.on('end', () => ok(b));
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, readFileSync(join(here, 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/hello') return send(res, 200, { app: 'style-studio', pid: process.pid });
    // a newer Style Studio asks this one to step aside; the custom header keeps web pages from doing it
    if (req.method === 'POST' && url.pathname === '/api/quit' && req.headers['x-style-studio'] === 'replace') {
      send(res, 200, { ok: true });
      console.log('A newer Style Studio started; closing this one.');
      return server.close(() => process.exit(0));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const refresh = url.searchParams.has('refresh');
      return send(res, 200, { frames: frames(refresh).map((f) => `/frames/${f}`), split: splitFrames(refresh).map((f) => `/frames/${f}`), styles: listStyles(), default: defaultSlug() });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/frames/')) {
      const name = url.pathname.slice(8);
      if (!/^(frame-\d|split-screen|split-face)\.jpg$/.test(name) || !existsSync(join(cacheDir, name))) return send(res, 404, { error: 'no frame' });
      return send(res, 200, readFileSync(join(cacheDir, name)), 'image/jpeg');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/styles/')) {
      const slug = url.pathname.slice(12);
      if (!SLUG.test(slug) || !existsSync(join(stylesDir, `${slug}.json`))) return send(res, 404, { error: 'not found' });
      return send(res, 200, readFileSync(join(stylesDir, `${slug}.json`), 'utf8'));
    }
    if (req.method === 'POST' && url.pathname === '/api/styles') {
      const s = JSON.parse(await readBody(req));
      if (!SLUG.test(s.slug || '') || !s.name) return send(res, 400, { error: 'name and slug (a-z, 0-9, -) required' });
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
      s.updated = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      writeFileSync(join(stylesDir, `${s.slug}.json`), JSON.stringify(s, null, 2));
      writeFileSync(join(stylesDir, `${s.slug}.md`), toMarkdown(s));
      if (s.makeDefault) writeFileSync(join(stylesDir, 'DEFAULT'), s.slug);
      return send(res, 200, { ok: true, slug: s.slug, styles: listStyles(), default: defaultSlug() });
    }
    if (req.method === 'POST' && url.pathname === '/api/default') {
      const { slug } = JSON.parse(await readBody(req));
      if (!SLUG.test(slug || '') || !existsSync(join(stylesDir, `${slug}.json`))) return send(res, 400, { error: 'unknown style' });
      writeFileSync(join(stylesDir, 'DEFAULT'), slug);
      return send(res, 200, { ok: true, default: slug });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});
server.on('listening', () => console.log(`Style Studio: http://localhost:${server.address().port}  (styles saved to ${stylesDir})`));

// Only one Style Studio at a time, so the page never shows old code: if the port is taken by another Style
// Studio it is asked to close; one from before this check existed can't be, so this one says how to close
// it and opens on the next free port. Anything else on the port is left alone.
const ask = (port, path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...opts, signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
function holder(port) { // the process id listening on the port, when the system can tell
  const win = process.platform === 'win32';
  const out = spawnSync(win ? 'netstat' : 'lsof', win ? ['-ano', '-p', 'TCP'] : ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
  return win ? out.split('\n').find((l) => l.includes(`:${port} `) && /LISTENING/.test(l))?.trim().split(/\s+/).pop() : out.trim().split('\n')[0];
}
function listen(port, tries = 0) {
  const onError = async (e) => {
    if (e.code !== 'EADDRINUSE' || port > PORT + 20) throw e;
    if (tries === 0 && (await ask(port, '/api/hello'))?.app === 'style-studio') {
      await ask(port, '/api/quit', { method: 'POST', headers: { 'X-Style-Studio': 'replace' } });
      return setTimeout(() => listen(port, 1), 400);
    }
    if (tries > 0 && tries < 8) return setTimeout(() => listen(port, tries + 1), 400);
    if (port === PORT) {
      const old = (await ask(port, '/api/state'))?.styles, pid = holder(port);
      console.log(old
        ? `An older Style Studio is still open on port ${port}${pid ? ` (process ${pid})` : ''} and can't be closed from here.`
          + (pid ? ` To close it: Task Manager > Details > node.exe with PID ${pid} > End task, or run: ${process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`}` : '')
        : `Port ${port} is used by another program${pid ? ` (process ${pid})` : ''}; leaving it alone.`);
    }
    listen(port + 1);
  };
  server.once('error', onError);
  server.once('listening', () => server.off('error', onError));
  server.listen(port, '127.0.0.1');
}
listen(PORT);
