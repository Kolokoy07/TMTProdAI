// TMTProdAI window: setup checks, drop zone, progress and review. The editing is one hidden
// Claude Code session per video; notes and approval resume that same session.
const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog;
const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;

const $ = (id) => document.getElementById(id);
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const HEADLESS =
  'You are running hidden inside the TMTProdAI desktop app, so nobody can answer questions mid-edit. ' +
  "Don't ask anything: use my saved style and rules, and pick sensible defaults. Don't open the video " +
  'yourself; the app plays it. Finish with 3 to 5 short bullets on what you did, then a last line ' +
  'exactly like "OUTPUT: outbox/<file>.mp4" naming the video you rendered.';
const PROMPTS = {
  edit: (file) => `edit this: ${file}\n\n${HEADLESS}`,
  notes: (text) => `Notes on the draft: ${text}\n\nApply them and render the next version.\n\n${HEADLESS}`,
  approve: () => `Approved, final. Render the final version.\n\n${HEADLESS}`,
};
const STEPS = ['Getting ready', 'Transcribing', 'Cutting', 'Designing', 'Rendering'];
const STEP_HINTS = [
  [4, /render|outbox|-final|\bv\d+\.mp4/i],
  [3, /hyperframes|caption|composition|motion|hook|design|\.html/i],
  [2, /silence|cut|edl|trim|mistake|clean/i],
  [1, /transcrib/i],
];

let status = null;
let job = load(); // { file, session, output, summary, kind } for the video being worked on
let run = null; // the turn running now: { started, step, timer, result, error }

function load() {
  try { return JSON.parse(localStorage.getItem('job')) || null; } catch { return null; }
}
function save() {
  try { job ? localStorage.setItem('job', JSON.stringify(job)) : localStorage.removeItem('job'); } catch {}
}

function show(id) {
  for (const s of ['setup', 'home', 'editing', 'review']) $(s).hidden = s !== id;
  $('home-btn').hidden = id === 'home' || id === 'setup' || id === 'editing';
  if (id !== 'editing') error('');
}
function error(text) {
  $('error').textContent = text;
  $('error').hidden = !text;
}

// ---- Setup ----

async function boot() {
  status = await invoke('status');
  const checks = [
    status.repo
      ? [true, `TMTProdAI folder: <code>${esc(status.repo)}</code>`]
      : [false, 'Choose your TMTProdAI folder (the one with AGENTS.md and setup.mjs).'],
    status.claude
      ? [true, 'Claude Code is installed.']
      : [false, 'Install Claude Code: open PowerShell and run <code>npm install -g @anthropic-ai/claude-code</code>, then run <code>claude</code> once to sign in.'],
    status.kit
      ? [true, 'The editing kit is set up.']
      : [false, 'The editing kit is missing. Open TMTProdAI in Claude and say <code>start</code> once.'],
  ];
  if (checks.every(([ok]) => ok)) return job?.output ? review() : home();
  $('checks').innerHTML = checks.map(([ok, html]) => `<li class="${ok ? 'ok' : 'no'}">${html}</li>`).join('');
  show('setup');
}

$('pick-repo').onclick = async () => {
  const dir = await open({ directory: true, title: 'Choose your TMTProdAI folder' });
  if (!dir) return;
  try { await invoke('set_repo', { path: dir }); boot(); } catch (e) { error(String(e)); }
};
$('recheck').onclick = boot;

// ---- Home ----

async function home() {
  show('home');
  const drafts = await invoke('drafts');
  $('drafts-title').hidden = !drafts.length;
  $('drafts').innerHTML = '';
  for (const d of drafts.slice(0, 12)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name">${esc(d.name)}</span><span class="when">${ago(d.modified)}</span>`;
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = 'Watch';
    btn.onclick = () => invoke('open_path', { path: d.path, reveal: false });
    li.append(btn);
    $('drafts').append(li);
  }
}

$('pick-video').onclick = async () => {
  const file = await open({ title: 'Choose a video', filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }] });
  if (file) start(file);
};
$('home-btn').onclick = () => { job = null; save(); home(); };

getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
  const drop = $('drop');
  if ($('home').hidden) return;
  if (payload.type === 'enter' || payload.type === 'over') drop.classList.add('over');
  else drop.classList.remove('over');
  if (payload.type === 'drop') {
    const file = payload.paths.find((p) => VIDEO.test(p));
    file ? start(file) : error("That isn't a video. Drop an MP4, MOV, M4V, WEBM or MKV file.");
  }
});

async function start(path) {
  try {
    const file = await invoke('add_video', { path });
    job = { file, session: null, output: null, summary: '' };
    save();
    turn('edit', PROMPTS.edit(file));
  } catch (e) { error(String(e)); }
}

// ---- One Claude turn ----

async function turn(kind, prompt) {
  run = { kind, started: Date.now(), step: 0, result: null, error: null, before: job.output };
  $('editing-title').textContent = { edit: 'Editing', notes: 'Making the next version', approve: 'Rendering the final' }[kind];
  $('editing-file').textContent = job.file.replace(/^inbox\//, '');
  $('log').innerHTML = '';
  $('now').textContent = 'Starting Claude Code…';
  $('cancel').disabled = false;
  paintSteps();
  show('editing');
  run.timer = setInterval(() => ($('elapsed').textContent = clock(Date.now() - run.started)), 1000);
  try {
    await invoke('run_claude', { prompt, resume: job.session });
  } catch (e) {
    clearInterval(run.timer);
    run = null;
    show(job.output ? 'review' : 'home');
    error(String(e));
  }
}

function paintSteps() {
  $('steps').innerHTML = STEPS.map((s, i) =>
    `<li class="${i < run.step ? 'done' : i === run.step ? 'active' : ''}">${s}</li>`).join('');
}

function note(text) {
  if (!text) return;
  $('now').textContent = text.length > 160 ? text.slice(0, 160) + '…' : text;
  const li = document.createElement('li');
  li.textContent = text;
  $('log').append(li);
  $('log').scrollTop = $('log').scrollHeight;
  const hit = STEP_HINTS.find(([, re]) => re.test(text));
  if (hit && hit[0] > run.step) { run.step = hit[0]; paintSteps(); }
}

listen('claude-line', ({ payload }) => {
  if (!run) return;
  let ev;
  try { ev = JSON.parse(payload); } catch { return; }
  if (ev.session_id) { job.session = ev.session_id; save(); }
  if (ev.type === 'assistant') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'text') note(c.text.trim().split('\n')[0]);
      if (c.type === 'tool_use') note(describe(c));
    }
  }
  if (ev.type === 'result') {
    run.result = ev.result || '';
    if (ev.is_error) run.error = run.result || ev.subtype;
  }
});
listen('claude-err', ({ payload }) => {
  if (run && payload.trim()) $('log').insertAdjacentHTML('beforeend', `<li>${esc(payload)}</li>`);
});
listen('claude-exit', async ({ payload: code }) => {
  if (!run) return;
  clearInterval(run.timer);
  const done = run;
  run = null;
  const text = done.result || '';
  const named = text.match(/OUTPUT:\s*`?([^\s`]+\.mp4)/i)?.[1];
  let output = named ? `${status.repo}\\${named.replace(/\//g, '\\')}` : null;
  if (!output) {
    // No OUTPUT line: take the newest draft written during this turn.
    const fresh = (await invoke('drafts')).find((d) => d.modified * 1000 >= done.started - 5000);
    output = fresh?.path || null;
  }
  if (code !== 0 || done.error || !output || output === done.before) {
    const why = done.error || (code === -1 || code === 1 ? lastLog() : '') || 'No new video came out.';
    job.output ? review() : home();
    error(`The edit stopped before a video was ready.\n${signInHint(why)}`);
    return;
  }
  job.output = output;
  job.summary = text.replace(/^.*OUTPUT:.*$/gim, '').trim();
  job.final = done.kind === 'approve';
  save();
  review();
});

function describe(tool) {
  const i = tool.input || {};
  if (tool.name === 'Bash') return i.description || i.command?.split('\n')[0];
  if (tool.name === 'Skill') return `Using ${i.skill || i.command || 'a skill'}`;
  if (i.file_path) return `${tool.name === 'Read' ? 'Reading' : 'Writing'} ${i.file_path.split(/[\\/]/).slice(-2).join('/')}`;
  return tool.name;
}
function lastLog() {
  const items = $('log').querySelectorAll('li');
  return items.length ? items[items.length - 1].textContent : '';
}
function signInHint(why) {
  return /log ?in|auth|api key|credential|401/i.test(why)
    ? `${why}\nClaude Code isn't signed in. Open PowerShell, run "claude", sign in, then try again.`
    : why;
}

$('cancel').onclick = () => { $('cancel').disabled = true; $('now').textContent = 'Stopping…'; invoke('cancel'); };

// ---- Review ----

function review() {
  show('review');
  const name = job.output.split(/[\\/]/).pop();
  $('review-title').textContent = job.final ? `Final: ${name}` : name;
  $('summary').textContent = job.summary || '';
  $('video').src = convertFileSrc(job.output) + `?t=${Date.now()}`;
  $('notes').value = '';
  $('approve').disabled = !!job.final;
}

$('send-notes').onclick = () => {
  const text = $('notes').value.trim();
  if (!text) return $('notes').focus();
  turn('notes', PROMPTS.notes(text));
};
$('approve').onclick = () => turn('approve', PROMPTS.approve());
$('play').onclick = () => invoke('open_path', { path: job.output, reveal: false });
$('reveal').onclick = () => invoke('open_path', { path: job.output, reveal: true });

// ---- Helpers ----

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function ago(secs) {
  const m = Math.round((Date.now() / 1000 - secs) / 60);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

boot();
