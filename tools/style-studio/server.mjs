#!/usr/bin/env node
// Style Studio: a local page for building named short-form styles (colours, fonts, hook, captions,
// visuals, extras) on frames of your own footage. Saves to styles/<slug>.json plus a readable
// styles/<slug>.md that the free247editor skill reads when editing.
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

const listStyles = () => (existsSync(stylesDir) ? readdirSync(stylesDir) : [])
  .filter((f) => f.endsWith('.json')).map((f) => {
    try { const s = JSON.parse(readFileSync(join(stylesDir, f), 'utf8')); return { slug: s.slug, name: s.name, updated: s.updated }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
const defaultSlug = () => { try { return readFileSync(join(stylesDir, 'DEFAULT'), 'utf8').trim(); } catch { return null; } };

// The .md is what the editor reads: plain bullets with the exact values to apply.
function toMarkdown(s) {
  const c = s.colours, f = s.fonts, h = s.hook, k = s.captions, v = s.visuals, x = s.extras;
  return `# Style: ${s.name}

Saved from Style Studio ${s.updated}. Machine-readable values: \`styles/${s.slug}.json\`.

- Format: ${s.format}
- Colours (${c.id}): headline gradient ${c.primary} to ${c.primaryEnd}, accent ${c.accent}, captions ${c.caption}, shade ${c.shade}
- Fonts (${f.id}): headline ${f.headline.family} ${f.headline.weight}${f.headline.upper ? ' UPPERCASE' : ''}, tracking ${f.headline.tracking}em; accent ${f.accent.family} ${f.accent.italic ? 'italic ' : ''}${f.accent.weight}; small line ${f.body.family} ${f.body.weight}; captions ${f.caption.family} ${f.caption.weight}
- Hook: ${h.layout} layout, ${h.motion} motion, on screen ${h.minSeconds}-${h.maxSeconds} s${h.avoidAction ? ', ends early if it would cover action' : ''}; sound ${h.sound}
- Captions: ${k.style}, max ${k.maxChars} characters, one line${k.highlight ? ', key word in accent' : ''}, ${k.position} (y ${k.y}), ${k.size}px${k.box ? ', dark box' : ', stroke + shadow'}
- Titles: ${v.titleLayout}, backing ${v.backing}, ${v.motion} motion, fully on screen at least ${v.titleMinHold} s (+0.3 s per word past 3)
- Look: grade ${v.grade}, pace ${v.pace}, punch-in zooms ${v.punchIns}
- Sound: SFX ${x.sfx}; music ${x.music} about ${Math.abs(x.musicDb)} dB under the voice, ducked under speech
- CTA: keyword "${x.ctaKeyword}"${x.ctaPops ? ', pop on each spoken keyword' : ''}
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

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, readFileSync(join(here, 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, { frames: frames(url.searchParams.has('refresh')).map((f) => `/frames/${f}`), styles: listStyles(), default: defaultSlug() });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/frames/')) {
      const name = url.pathname.slice(8);
      if (!/^frame-\d\.jpg$/.test(name) || !existsSync(join(cacheDir, name))) return send(res, 404, { error: 'no frame' });
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
}).listen(PORT, '127.0.0.1', () => console.log(`Style Studio: http://localhost:${PORT}  (styles saved to ${stylesDir})`));
