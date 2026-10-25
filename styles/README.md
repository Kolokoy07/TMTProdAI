# styles/

Named short-form styles made in Style Studio (`node tools/style-studio/server.mjs`, then open
http://localhost:4747). Each style is saved twice:

- `<slug>.json`: exact values (colours, fonts, hook, captions, titles, look, sound, CTA).
- `<slug>.md`: the same values as plain bullets, for the editor to read.

`DEFAULT` holds the slug used when you just say "edit this". Say "edit this with <style name>" to
use another one. Everything here except this README stays on your computer (see `.gitignore`).
