#!/usr/bin/env bash
# Build, sign (free Apple ID), USB-install and launch LOJO Mail on the attached iPhone.
#   ios/scripts/deploy-phone.sh           build + sign + install + launch
#   ios/scripts/deploy-phone.sh --build   unsigned compile check only
# Same workflow as LOJO Networks (macdadyj/lojo-private-networks-ios).
set -euo pipefail

IOS="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="${LOJO_BUNDLE:-XTL-HG9HAYXW44.com.lojo.Mail}"

# shellcheck disable=SC1091
source "$HOME/.config/ios-dev/env"
export PATH="$SWIFT_ROOT/usr/bin:$HOME/.local/bin:$PATH"
mkdir -p "$XTL_TMPDIR"

# The phone's UDID is a device identifier: read it from USB at run time, never commit it.
UDID="${LOJO_UDID:-$(pymobiledevice3 usbmux list --usb 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["Identifier"] if d else "")')}"
if [[ -z "$UDID" && "${1:-}" != "--build" ]]; then
  echo "No iPhone on USB. Plug it in, unlock it and tap Trust." >&2
  exit 1
fi

BUILD_DIR="$("$IOS/scripts/sync-app.sh")"
cd "$BUILD_DIR"

if [[ "${1:-}" == "--build" ]]; then
  exec xtool dev build
fi

xtool dev run --usb --udid "$UDID"
sleep 1
pymobiledevice3 developer core-device launch-application --userspace "$BUNDLE" '' >/dev/null
echo "installed + launched $BUNDLE"
