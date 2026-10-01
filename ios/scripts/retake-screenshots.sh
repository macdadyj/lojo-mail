#!/usr/bin/env bash
# Retake the README screenshots from the installed app. Launches only: nothing is installed, sent or changed.
#   LOJO_PHONE="14 Pro Max" ios/scripts/retake-screenshots.sh            all of them
#   LOJO_PHONE="14 Pro Max" ios/scripts/retake-screenshots.sh 08 15      only these numbers
# Install the build you want to photograph first (ios/scripts/deploy-phone.sh). Images are scaled to 828 px wide,
# 8-bit, so they match whichever iPhone took them. Check each one before committing: they show the live mailbox.
set -euo pipefail

IOS="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$IOS/docs/screenshots"
RAW="$(mktemp -d)"
trap 'rm -rf "$RAW"' EXIT

shots=(
  "01-sign-in|LOJO_SCREEN=signin"
  "02-inbox|LOJO_SCREEN=inbox"
  "03-thread-decrypted|LOJO_SCREEN=thread"
  "04-attachment-preview|LOJO_SCREEN=attachment"
  "05-search|LOJO_SCREEN=search LOJO_SEARCH=invoice"
  "06-folder-sent|LOJO_SCREEN=folder LOJO_FOLDER=sent"
  "07-folder-trash|LOJO_SCREEN=folder LOJO_FOLDER=trash"
  "07b-trash-thread|LOJO_SCREEN=thread LOJO_FOLDER=trash"
  "08-compose|LOJO_SCREEN=compose LOJO_COMPOSE_TO=lojo-test@cyberphysical.us"
  "09-send-confirm|LOJO_SCREEN=sendconfirm LOJO_COMPOSE_TO=lojo-test@cyberphysical.us"
  "10-review|LOJO_SCREEN=review"
  "11-draft-review|LOJO_SCREEN=draft"
  "12-ai-rules|LOJO_SCREEN=rules"
  "13-settings|LOJO_SCREEN=settings"
  "14-key-setup|LOJO_SCREEN=key"
  "15-compose-attachments|LOJO_SCREEN=compose LOJO_COMPOSE_TO=lojo-test@cyberphysical.us LOJO_COMPOSE_SAMPLES=1"
)

wanted=("$@")
for entry in "${shots[@]}"; do
  name="${entry%%|*}"
  read -r -a vars <<< "${entry#*|}"
  if (( ${#wanted[@]} )); then
    match=0
    for w in "${wanted[@]}"; do [[ "$name" == "$w"* ]] && match=1; done
    (( match )) || continue
  fi
  "$IOS/scripts/phone-shot.sh" "$RAW/$name.png" "${vars[@]}" >/dev/null
  ffmpeg -loglevel error -y -i "$RAW/$name.png" -vf scale=828:-1 -pix_fmt rgb24 "$OUT/$name.png"
  echo "$OUT/$name.png"
done
