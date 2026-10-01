#!/bin/sh
# Turn send-new off and put grok's caps back to 10/hour and 30/day.
# Run on Santa as Jon. Asks for the lojo-mail passphrase once. Prints no secrets.
# Does not call AWS. Does not change receiving, auto-send, or rules.
set -eu

echo "Reverting grok: send-new off, 10/hour, 30/day."
echo "You will be asked for your lojo-mail passphrase. It is not printed."
lojo-bot admin send-window grok --revert
echo "Done. Chat-approved replies stay available at the safe caps if send-approved is still granted."
