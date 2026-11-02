# TMTProdAI for Windows

A small desktop window for TMTProdAI: drop a raw video on it, watch the progress, play the
draft, type notes ("faster", "bigger captions"), and approve the final. The editing is done by
your own Claude Code, run hidden in your TMTProdAI folder, so it follows the same skill, style
and `my-rules.md` as when you edit in a chat.

## Before you use it

- TMTProdAI set up once (open it in Claude and say `start`), so `kit/` exists.
- Claude Code installed and signed in: `npm install -g @anthropic-ai/claude-code`, then run
  `claude` once in PowerShell and sign in.

The app checks both on launch and tells you what's missing.

## How it works

| Screen | What happens |
| --- | --- |
| Home | Drop a video (or choose one). It's copied into `inbox/`; your original is never touched. Earlier drafts from `outbox/` are listed. |
| Editing | Runs `claude -p` in the TMTProdAI folder with "edit this: inbox/&lt;file&gt;". Shows the steps (getting ready, transcribing, cutting, designing, rendering) and a Stop button. |
| Review | Plays the draft. Notes and Approve resume the same Claude session, so it remembers the edit. |

The hidden Claude Code may run commands and edit files in the TMTProdAI folder without asking,
because nobody is there to answer a prompt. It still follows the skill's "Never" list: no
uploads, no paid services.

## Build it

Needs Node, Rust (`rustup`) and the Visual Studio 2022 C++ build tools.

```
cd app
npm install
npm run build
```

The installer lands in `src-tauri/target/release/bundle/nsis/` (installs for your user only,
no admin prompt). `npm run dev` runs it without installing.

| Part | What it is |
| --- | --- |
| `ui/` | The window: plain HTML, CSS and JS, no build step. |
| `src-tauri/src/lib.rs` | Finds the TMTProdAI folder and Claude Code, copies videos into `inbox/`, runs Claude hidden and streams its progress. |
| `src-tauri/tauri.conf.json` | Window, installer and which folders the player may read (`outbox/` only). |
