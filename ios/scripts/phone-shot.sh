#!/usr/bin/env bash
# Launch the app on the iPhone straight into one screen and save a screenshot.
#   ios/scripts/phone-shot.sh OUT.png [KEY=VALUE ...]
# Keys are the QA launch variables in ios/docs/TESTING.md, e.g.
#   ios/scripts/phone-shot.sh ios/docs/screenshots/01-inbox.png LOJO_SCREEN=inbox
#   ios/scripts/phone-shot.sh /tmp/thread.png LOJO_SCREEN=thread
# Wait time before the capture: LOJO_SHOT_WAIT (seconds, default 6).
set -euo pipefail

OUT="$1"; shift
BUNDLE="${LOJO_BUNDLE:-XTL-HG9HAYXW44.com.lojo.Mail}"
WAIT="${LOJO_SHOT_WAIT:-6}"

args=()
for kv in "$@"; do args+=(--env "$kv"); done

pymobiledevice3 developer core-device launch-application --userspace --kill-existing \
  "${args[@]}" "$BUNDLE" '' >/dev/null
sleep "$WAIT"
mkdir -p "$(dirname "$OUT")"
pymobiledevice3 developer core-device screen-capture screenshot --userspace "$OUT" 2>&1 | tail -1
