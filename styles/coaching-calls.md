# Style: Coaching Calls

Made 2026-10-26 for coaching calls to students and traders (Zoom recordings with camera tiles and
chart screen-shares). Exact values: `styles/coaching-calls.json`. Script: `styles/coaching-calls/clip.mjs`.

- Clips: only the best teaching and inspirational moments, each at least 60 s (60-110 s). Rank them with
  `styles/coaching-calls/clip-selection-prompt.md`; open on the student's problem or question whenever possible.
- Format: 9:16 1080x1920 on solid black. No split screen for camera scenes.
- Camera parts: the speaker as a full-width square (1080x1080) centred in the frame (y 420).
- Screen-share scenes (charts with a small webcam): the chart crop at full 1080 width on top (y 400), the
  coach's webcam enlarged below it (420 px square, y 1250), captions between them. Set `chartRanges` (source
  seconds when the share is on) plus `share` crops in `clips.json`; parts switch layout automatically.
  Chosen 2026-10-26 for the 2026-04-11 call, where the user left the layout to the editor.
- Recordings that switch between share and camera put the hook in the top band (`hookBottom` 380) so it
  never covers the chart.
- Hook: short white caps on a red box per line (#E3161D), Arial Black, 2-3 lines of max ~18 characters,
  on the video over the speaker's chest, on screen for the first 4.5 s (always under 5 s). No animation.
- Captions: one short line (max 24 characters), white caps on a black box, just under the video,
  above the Reels/TikTok safe line.
- Student names: if a student's surname shows anywhere (Zoom name tile, camera label, caption), blur the surname
  and keep the first name. Coaches' names stay. Check every clip before rendering.
- Cuts: tight (pauses over 0.35 s removed), no speed-ups. Voice only, levelled to -14 LUFS. No music or SFX.
- Rendered with plain FFmpeg (fast and free), not HyperFrames.
