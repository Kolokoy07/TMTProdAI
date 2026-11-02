# Style: Coaching Calls

Made 2026-10-26 for coaching calls to students and traders (Zoom recordings with camera tiles and
chart screen-shares). Updated 2026-11-02: split screen, 1:30 minimum, curiosity hooks. Exact values:
`styles/coaching-calls.json`. Script: `styles/coaching-calls/clip.mjs`.

- Clips: only the best teaching and inspirational moments, each at least 1:30 (90-150 s). Every clip holds
  the full arc: the student's problem, then the coach's solution, ending on the payoff. Rank them with
  `styles/coaching-calls/clip-selection-prompt.md`; open on the student's problem or question whenever possible.
- Format: 9:16 1080x1920 on solid black.
- Three layouts, switched per part:
  - Coach talking on camera: the coach as a full-width square (1080x1080) centred in the frame (y 420).
  - Coach showing charts (`"chart"` parts, or inside `chartRanges`): split screen. The chart fills the top half
    (fitted to 1080x960 and sitting on the seam, so a 16:9 chart leaves a black band above it for the hook). The
    coach's webcam fills the bottom half (1080x960), zoomed in with no border. Crops: `share.chart` and `share.cam`.
  - Student talking (`"student"` parts, or inside `studentRanges`): split screen. The student fills the top half
    and the coach (listening) fills the bottom half, both 1080x960 with no borders. Crops: `split.student` and
    `split.coach` (per clip when the student changes).
- Captions: one short line (max 24 characters), white caps on a black box. Coach-only parts put them just under
  the video; split parts put them on the seam between the halves. Always above the Reels/TikTok safe line.
- Hook: short white caps on a red box per line (#E3161D), Arial Black, 2-3 lines of max ~18 characters, on screen
  for the first 4.5 s (always under 5 s). No animation. Placed by the first part's layout: over the coach's chest
  (coach only), in the black band above the chart (chart split), or over the student's chest (student split).
- Hook words: write them to stop the scroll. Build each from the student's problem plus the payoff, using one of
  these formulas, filled in with the clip's real topic:
  - "This is how / This is why": THIS IS HOW / YOU STOP / REVENGE TRADING
  - "How a [trader] [result]": HOW A TRADER / FIXED HIS / STOP LOSSES
  - "Why you keep [pain]": WHY YOU KEEP / GETTING / STOPPED OUT
  - "Stop [mistake] if...": STOP MOVING / YOUR STOP LOSS
  - "The real reason / The truth about": THE REAL REASON / YOU OVERTRADE
  - "Do this when / before": DO THIS BEFORE / YOU ENTER / A TRADE
  - Student's own words as a confession: "I KEEP / BREAKING / MY RULES"
  Rules: name the pain the viewer has (losing, FOMO, overtrading, stop losses, prop firm), promise the answer
  without giving it away, never promise money or results the clip does not show, and use plain trader words.
  Put the strongest word on the last line. Give 2-3 options per clip in the clip report.
- Student names: if a student's surname shows anywhere (Zoom name tile, camera label, caption), blur the surname
  and keep the first name. Coaches' names stay. Check every clip before rendering.
- Cuts: tight (pauses over 0.35 s removed), no speed-ups. Voice only, levelled to -14 LUFS. No music or SFX.
- Rendered with plain FFmpeg (fast and free), not HyperFrames.
