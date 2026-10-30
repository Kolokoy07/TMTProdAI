#!/usr/bin/env bash
# Builds, mixes, renders, and delivers each reel; keeps going when one fails and logs it.
#   bash render-all.sh r01 r02 ...            (outbox/<name>-reel-NN-<topic>-v1.mp4)
#   STYLE=simple-split SUFFIX=simple-v1 bash render-all.sh r01 ...   (another style, another file name)
cd "$(dirname "$0")"
OUT=../../../outbox
PREFIX=$(node -e "console.log(require('./source.json').name)")
SUFFIX=${SUFFIX:-v1}
mkdir -p renders review
for id in "$@"; do
  slug=$(node -e "const r=require('./reels.json').find(r=>r.id==='$id');console.log(r.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''))")
  n=${id#r}
  echo "== $id $slug"
  if node build-reel.mjs "$id" && node mix-reel.mjs "$id" \
    && npx hyperframes render -c "$id.html" --output "renders/$id.mp4" > "renders/$id.log" 2>&1 \
    && ffmpeg -v error -y -i "renders/$id.mp4" -i "assets/$id/audio.wav" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest -movflags +faststart "$OUT/$PREFIX-reel-$n-$slug-$SUFFIX.mp4"; then
    d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$PREFIX-reel-$n-$slug-$SUFFIX.mp4")
    ffmpeg -v error -y -i "renders/$id.mp4" -vf "fps=1/5,scale=240:-1,tile=6x3" -frames:v 1 "review/$id-$SUFFIX.jpg"
    echo "OK $id $d s"
  else
    echo "FAIL $id"; tail -5 "renders/$id.log" 2>/dev/null
  fi
done
echo "== done"
