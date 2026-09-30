#!/usr/bin/env bash
# Linux-host tests for LojoMailCore: seal envelopes with the repo's TypeScript crypto, open them in Swift.
#   ios/scripts/test-core.sh           offline tests only
#   ios/scripts/test-core.sh --live    also read (never write) the deployed API with Jon's session and envelope key
#   ios/scripts/test-core.sh --live-write  --live plus the write round-trips in LiveWriteTests (sends one message to lojo-test@)
# --live reads the passphrase and key from ~/.config/lojo-mail (override with LOJO_PASSPHRASE_FILE / LOJO_KEY_FILE).
set -euo pipefail

IOS="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$IOS/.." && pwd)"
API="${LOJO_API:-https://zp7h9ytl28.execute-api.us-east-1.amazonaws.com}"

if [[ -f "$HOME/.config/ios-dev/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.config/ios-dev/env"
  export PATH="$SWIFT_ROOT/usr/bin:$HOME/.local/bin:$PATH"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lojo-mail-test.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
(cd "$REPO" && npx tsx ios/CoreTests/make-vectors.ts "$WORK/vectors" >/dev/null)
export LOJO_VECTORS="$WORK/vectors"

if [[ "${1:-}" == "--live" || "${1:-}" == "--live-write" ]]; then
  [[ "$1" == "--live-write" ]] && export LOJO_LIVE_WRITE=1
  shift
  "$IOS/scripts/session-token.sh" "$API" --token > "$WORK/session"
  export LOJO_LIVE_SESSION_FILE="$WORK/session"
  export LOJO_LIVE_KEY_FILE="${LOJO_KEY_FILE:-$HOME/.config/lojo-mail/keys/envelope.private.jwk}"
  export LOJO_LIVE_API="$API"
fi

cd "$IOS/CoreTests"
swift test "$@"
