# Coaching Calls: template

Script for the Coaching Calls style (`styles/coaching-calls.md`). Plain FFmpeg, no HyperFrames.

1. From `kit/`: `npm run new-video -- <slug>`; copy the recording to `assets/raw.mp4` and `clip.mjs` into
   the project folder. Make `fonts/` there with `ariblk.ttf` from `C:\Windows\Fonts`.
2. From the repo root: `node tools/transcribe.mjs kit/video-projects/<slug>/assets/raw.mp4`.
3. Check frames for chart screen-shares, read the transcript, and write `clips.json`:
   `{ "name": "<slug>", "cx": 0.47, "clips": [{ "id": "c01", "slug": "topic", "hook": ["LINE ONE", "line *accent*"],
   "segs": [[start, end], [start, end, "chart"]], "fix"?: [["misheard", "Correct"]] }] }`.
   Optional `"blur": [{ "x", "y", "w", "h", "from", "to" }]` (source pixels and seconds, whole call or per clip) blurs
   a student surname. `cx` is where the coach sits across the frame (0-1) for coach-only parts.
   Coach showing charts (split, chart on top): mark parts `"chart"` or add `"chartRanges": [[from, to]]`, plus
   `"share": { "chart": [x, y, w, h], "cam": [x, y, w, h] }` (source pixels).
   Student talking, no charts (split, name card on top): mark parts `"student"` (4th value or clip `"student"` = first name)
   or add `"studentRanges"`, plus `"listen": { "at", "len", "crop": [x, y, w, h] }` (a quiet on-camera stretch of the coach).
   Student sharing charts: mark `"studentchart"` with `"studentShare": { "chart": [x, y, w, h] }`.
   Crop boxes near 9:8 fill the halves best. The hook places itself by the first part's layout (`hookBottom` overrides).
   Each clip is at least 90 s and runs from the student's problem through the coach's solution.
   Long recordings: transcribe in 30-minute audio parts and merge (Groq's 25 MB cap).
4. `node clip.mjs` (or `node clip.mjs c03 c07`): renders to `outbox/<slug>/` and a frame sheet per clip in `review/`.
5. Rank the clips with `clip-selection-prompt.md`, write `analysis.json`, then `node report.mjs` writes
   `outbox/<slug>/<slug>-clip-report.md`.
