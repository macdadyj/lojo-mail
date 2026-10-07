#!/usr/bin/env bash
# Hand LOJO Mail a fresh 12-hour session and the envelope private key over USB, so Jon doesn't have to type
# a JWK on the phone. Files go into the app's own container (house_arrest; only this paired, trusted host
# can do that for a development-signed app). The app imports them into the Keychain when it becomes
# active, and the "USB from Santa Computa" button does it immediately. The files are then deleted.
#   ios/scripts/provision-phone.sh            session + key
#   ios/scripts/provision-phone.sh --session  session only
# Reads ~/.config/lojo-mail/web-passphrase and ~/.config/lojo-mail/keys/envelope.private.jwk
# (override with LOJO_PASSPHRASE_FILE / LOJO_KEY_FILE). Nothing is printed, nothing is written in the repo.
set -euo pipefail

IOS="$(cd "$(dirname "$0")/.." && pwd)"
API="${LOJO_API:-https://zp7h9ytl28.execute-api.us-east-1.amazonaws.com}"
KEYFILE="${LOJO_KEY_FILE:-$HOME/.config/lojo-mail/keys/envelope.private.jwk}"

# shellcheck disable=SC1091
source "$HOME/.config/ios-dev/env"
export PATH="$SWIFT_ROOT/usr/bin:$HOME/.local/bin:$PATH"
# shellcheck source=phone-lib.sh
source "$IOS/scripts/phone-lib.sh"
lojo_pick_phone || exit 1
BUNDLE="$(lojo_mail_bundle)"

WORK="$(mktemp -d "${XTL_TMPDIR:-/tmp}/lojo-mail-provision.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

umask 077
"$IOS/scripts/session-token.sh" "$API" > "$WORK/session.json"

# VendContainer (not --documents): the app keeps UIFileSharingEnabled off, so Documents is not exposed.
push() { pymobiledevice3 apps push "$BUNDLE" "$1" "Documents/$2" >/dev/null; }
push "$WORK/session.json" "provision-session.json"
if [[ "${1:-}" != "--session" ]]; then
  [[ -r "$KEYFILE" ]] || { echo "no envelope key at $KEYFILE" >&2; exit 1; }
  push "$KEYFILE" "provision-envelope.private.jwk"
fi
lojo_launch_best_effort "$BUNDLE"
echo "provisioned $BUNDLE ($([[ "${1:-}" == "--session" ]] && echo "session only" || echo "session + envelope key")). Open LOJO Mail and tap USB from Santa Computa if it did not import on its own."
