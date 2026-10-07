#!/usr/bin/env bash
# Sign in as Jon (human session) and print {"sessionToken","expiresAt"} JSON on stdout, or just the token with --token.
# The passphrase is read from a file and never appears on a command line or in the output.
#   session-token.sh [API] [--token]
set -euo pipefail

API="${1:-https://zp7h9ytl28.execute-api.us-east-1.amazonaws.com}"
MODE="${2:-}"
PASSFILE="${LOJO_PASSPHRASE_FILE:-$HOME/.config/lojo-mail/web-passphrase}"
[[ -r "$PASSFILE" ]] || { echo "no passphrase file at $PASSFILE" >&2; exit 1; }

python3 - "$API" "$PASSFILE" "$MODE" <<'PY'
import json, sys, urllib.request, urllib.error
api, passfile, mode = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
with open(passfile) as f:
    passphrase = f.read().strip()
req = urllib.request.Request(api + "/v1/session/login", data=json.dumps({"passphrase": passphrase}).encode(),
                             headers={"content-type": "application/json"})
try:
    session = json.load(urllib.request.urlopen(req, timeout=20))
except urllib.error.HTTPError as e:
    sys.exit(f"sign-in failed: HTTP {e.code}")
print(session["sessionToken"] if mode == "--token" else json.dumps(session))
PY
