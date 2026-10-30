# Screen-share split: template

Scripts and sounds for the Screen-share split format (`styles/screen-share-split.md`). Kept here, outside
`kit/`, so re-running setup never removes them. Run everything from the video's project folder.

1. From `kit/`: `npm run new-video -- <slug>`, then copy `*.mjs` and `render-all.sh` from this folder
   into `kit/video-projects/<slug>/`.
2. `node prep.mjs "<recording>" <name>`: writes `source.json`, the 20 ms audio levels, and the whole
   talk transcribed in parts that end on finished sentences (`assets/full-readable.txt`).
3. Read `assets/full-readable.txt` and write `reels.json`: per reel an `id` (r01...), `title`, `hook`
   [heavy word, serif line, small question], `segs` [[start, end], ...] in source seconds (any order),
   `cards` ({ at: phrase, eyebrow, rows: [[phrase, "Text *gold*"]] } or { at, eyebrow, b, i }), and
   optional `fix` [["misheard words", "Correct"]] for captions. Show the topic list before cutting.
4. `node cut.mjs`: cuts each reel tight from the recording, crops the camera bubble from every corner,
   and re-transcribes each clip for exact captions (`KEEP_TR=1` keeps existing transcripts).
5. `node build-reel.mjs r01` and `npx hyperframes snapshot` (copy `r01.html` to `index.html` first) for
   preview frames; then `bash render-all.sh r01 r02 ...` renders into `outbox/<name>-reel-NN-<topic>-v1.mp4`
   and saves a frame sheet per reel in `review/`. Check every sheet.

Look and sound come from a Screen-share split style edited in Style Studio: `styles/screen-share-split.json`
unless `source.json` names another with `"style": "<slug>"` (colours, fonts, hook motion and sound, caption size and length, screen
zoom, card side, chip label, grade, SFX on/off, music level).

Bubble crops differ per recording. The defaults fit a 3840x2160 recording with a 23%-wide bubble in the
bottom-left, bottom-right, or top-left corner. For another layout, measure a frame and set `face`
(w:h:x:y crops in source pixels, keys L R C T) and `bubble` (fractions of the frame) in `source.json`.

`sounds/` holds the approved sound set; `mix-reel.mjs` copies it into each project.
