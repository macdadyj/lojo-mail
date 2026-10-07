#!/usr/bin/env bash
# Build, sign (free Apple ID), USB-install and launch LOJO Mail on the attached iPhone.
#   ios/scripts/deploy-phone.sh           build + sign + install + launch
#   ios/scripts/deploy-phone.sh --build   unsigned compile check only
# With several iPhones attached, pick one: LOJO_PHONE="14 Pro Max" ios/scripts/deploy-phone.sh (see phone-lib.sh).
# Same workflow as LOJO Networks (macdadyj/lojo-private-networks-ios).
set -euo pipefail

IOS="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck disable=SC1091
source "$HOME/.config/ios-dev/env"
export PATH="$SWIFT_ROOT/usr/bin:$HOME/.local/bin:$PATH"
mkdir -p "$XTL_TMPDIR"

# shellcheck source=phone-lib.sh
source "$IOS/scripts/phone-lib.sh"
if [[ "${1:-}" != "--build" ]]; then
  lojo_pick_phone || exit 1
fi

BUILD_DIR="$("$IOS/scripts/sync-app.sh")"
cd "$BUILD_DIR"

if [[ "${1:-}" == "--build" ]]; then
  exec xtool dev build
fi

xtool dev run --usb --udid "$LOJO_UDID"
sleep 1
if BUNDLE="$(lojo_mail_bundle)"; then
  lojo_launch_best_effort "$BUNDLE"
  echo "installed $BUNDLE"
else
  echo "warning: open LOJO Mail on the phone to finish import" >&2
fi
