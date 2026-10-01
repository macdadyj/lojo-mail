#!/bin/sh
# Grant bot grok a time-boxed send-new window. Run on Santa as Jon, after the
# API Lambda from this branch is deployed. Asks for the lojo-mail passphrase
# once (lojo-bot admin). Prints no token and no passphrase.
#
# Does not call AWS. Does not change receiving_stage, auto-send, or rules.
# lojo@ stays in test mode.
#
# Defaults: 30/hour, 100/day, 6 hours, chat approval required.
#   HOURS=4 APPROVAL=not-required ./scripts/santa/grant-send-new.sh
#
# Needs the existing scopes read,write,body,trash,rules,test-send,send-approved.
# send-window adds send-new and leaves the others in place.
set -eu

HOURS="${HOURS:-6}"
APPROVAL="${APPROVAL:-required}"

case "$HOURS" in
  ''|*[!0-9]*) echo "HOURS must be a whole number from 1 to 720" >&2; exit 1 ;;
esac
if [ "$HOURS" -lt 1 ] || [ "$HOURS" -gt 720 ]; then
  echo "HOURS must be a whole number from 1 to 720" >&2
  exit 1
fi
case "$APPROVAL" in
  required|not-required) ;;
  *) echo "APPROVAL must be required or not-required" >&2; exit 1 ;;
esac

echo "Opening send-new for grok: ${HOURS}h, 30/hour, 100/day, approval ${APPROVAL}."
echo "You will be asked for your lojo-mail passphrase. It is not printed."
lojo-bot admin send-window grok --per-hour 30 --per-day 100 --expires-in "${HOURS}h" --approval "$APPROVAL"

usage="$(CDPATH= cd -- "$(dirname "$0")/../../docs" && pwd)/lojo-bot-USAGE.txt"
if [ -f "$usage" ] && [ -d /home/jon ]; then
  install -m 644 "$usage" /home/jon/lojo-bot-USAGE.txt
  echo "Updated /home/jon/lojo-bot-USAGE.txt"
fi

echo "Rollback: scripts/santa/rollback-send-new.sh"
echo "Kill switch, any time: lojo-bot admin kill-switch on"
