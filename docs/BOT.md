# Jon's bot on lojo-mail (`lojo-bot`)

`lojo-bot` lets Jon's Grok Bot assistant (the Project Manager agent) manage the mailbox from Santa Computa: read, search, sort, label, move to Trash, run its own sort rules, propose automated rules, and write drafts and replies with attachments. By default it cannot send to anyone: drafts go to Jon, who presses Send in Thunderbird or the web app. Two opt-in exceptions, each a scope only Jon grants: a test message to `lojo-test@cyberphysical.us` (`test-send`), and a reply Jon approved in chat (`send-approved`, [below](#chat-approved-replies-send-approved)).

```text
Grok Bot box ──ssh──▶ Santa: lojo-bot user ──bot credential (lbt_…)──▶ lojo-mail API
                       │  ~lojo-bot/.config/lojo-bot/token                  │
                       │  ~lojo-bot/.config/lojo-bot/envelope.private.jwk   │ every request audited
                       │  (opens the bot's copy of each body)               │ as actor bot:<name>
                       ▼                                                    ▼
                 lojo-bot mcp | lojo-bot <op> | lojo-bot digest      drafts wait for Jon
```

It is one bundled file, `packages/bot/dist/lojo-bot.mjs` (`npm run build:bot`), with three faces over the same operations:

- `lojo-bot mcp`: a stdio MCP server.
- `lojo-bot <operation> --arg value`: a CLI that prints JSON.
- `lojo-bot digest`: new mail since the last run, as summary-ready JSON.

This is separate from the agent tokens in [BOTS.md](BOTS.md), which are SSM entries that Jon edits by hand and that work against remote `/mcp`. A bot credential is created and revoked by Jon from Santa with his passphrase. It takes effect on the next request (no 5-minute reload), and it does not work on remote `/mcp`.

## The bot credential

| | Bot credential (`lbt_<name>_…`) | Agent token (BOTS.md) | Bridge token | Jon's session |
| --- | --- | --- | --- | --- |
| Created by | Jon's session only (`lojo-bot admin create`) | Jon, in SSM | Jon, in SSM | passphrase |
| Stored server-side as | SHA-256 hash, in the budget table item `bots:registry` | plaintext SecureString | SecureString | not stored |
| Revocation | next request (`revoke`, `rotate`, global kill switch) | up to 5 minutes | up to 5 minutes | 12-hour expiry |
| Audit actor | `bot:<name>` | `agent:<label>` | `bridge` | `human` |
| Remote `/mcp` | refused (403) | yes | refused | n/a |
| Can ever hold `send`, `compose`, `client-send`, `admin` | **no** | no (`send`/`admin`) | `client-send` only | yes |

The token is 32 random bytes. It is shown exactly once, written to a mode-600 file by `lojo-bot admin create --out`, and never printed to the terminal, logs, or audit log. The API compares hashes in constant time. `lbt_` is a reserved prefix, so no static token can look like a bot credential.

### Scopes

| Scope | Default | Lets the bot |
| --- | --- | --- |
| `read` | yes (required) | list folders, inbox, triage, threads, drafts, labels, rules, settings, health, audit log; keyword search; digest |
| `write` | yes | mark read/unread, flag, set labels, move to inbox/archive/spam, restore from Trash, create/edit/discard drafts, add/remove draft files, submit a draft for Jon's approval, turn any rule **off** |
| `body` | yes | read message bodies (its own sealed copy, or the server's AI-context text), draft text, semantic search |
| `trash` | no | move mail to Trash: a soft delete, restorable until the retention window ends (the purge never deletes anything trashed less than 7 days ago), at most 100 per bot per day, recorded as `trashedBy: bot:<name>` |
| `rules` | no | add, replace and delete **its own** rules (`createdBy: bot`). Never one of Jon's rules, never a `trash` action, never auto-send. Shadow replies and shadow unsubscribes are **proposals**, saved disabled for Jon ([below](#automated-rules-shadow-first-unsubscribe-proposals)). Jon's switches and limits are untouched |
| `test-send` | no | `send_test_to_lojo_test`: plain text to `lojo-test@cyberphysical.us` and nobody else (hard-coded), subject prefixed `[lojo-bot test] `, at most 5,000 characters, 5 an hour and 20 a day per bot, stopped by the send kill switch, marked `Auto-Submitted` |
| `send-approved` | no | `review_for_send`, `send_approved_reply`: send a reply Jon approved in chat, to people already on the received thread. Needs `write`. Rate limited per bot (default 10 an hour, 30 a day) |
| `send-new` | no | `send_new`: a brand-new message to any recipient (To, Cc, Bcc, subject, body, attachments). Off until Jon grants it. Chat approval is required unless he waives it for a time-boxed window. Also lets a chat-approved reply go to people who were not on the thread |

`admin` does not imply any of `rules`, `test-send`, `send-approved` or `send-new`, and none can be given to an ordinary API token. A bot can never mint an approval or call `approve-and-send`, use `/v1/client/send`, export the mailbox, replace the rules document, enable a rule or take one live, release a kill switch, or manage bots. Those routes need Jon's session.

Bot drafts are agent drafts (`origin: agent`): only to existing contacts or thread participants, shown with the "an assistant wrote this" notice, and tagged `bot-draft` in Thunderbird.

## Reading bodies: the bot envelope key (opt-in)

Bodies are sealed to Jon's envelope key, and the server cannot open them. Nothing here weakens that. The bot gets its own key instead:

1. As the bot user, `lojo-bot key generate` creates a P-256 key pair. The private half stays in `~lojo-bot/.config/lojo-bot/envelope.private.jwk` (mode 600) and prints the public half.
2. Jon registers the public half: `lojo-bot admin set-key bot.public.jwk`. The API refuses a private key, and it refuses Jon's own public key.
3. From then on, the pipeline also seals `{text, html}` of each new message to the bot key, as a separate object `objects/<id>/bot/<keyId>.bin`. Jon's sealed body is unchanged. Sent copies get one too.
4. For older mail, Jon runs `lojo-bot admin backfill --private-key-file ~/.config/lojo-mail/envelope.private.jwk` as **his own** user. It opens each body locally with his key, re-seals it to the bot's public key, and uploads only the sealed copy. The plaintext never leaves his machine. It does 200 messages per run (`--limit`), oldest first; run it again until it reports 0.

The API serves a copy only for the key registered now. `lojo-bot admin remove-key` (or `set-key` with a new key) cuts the bot off from every existing copy at once. The copies are deleted with their message by the Trash purge. Copies do not include attachments: the bot sees attachment names and sizes, not their contents.

Without a bot key, a bot with `body` still gets the server's short-lived AI-context text where it exists (the same text the AI pipeline sees; [SECURITY.md](SECURITY.md#server-readable-data-drafts-and-the-ai-context-copy)). Without `body` it sees metadata and snippets only. Every body result says where it came from: `bot-key`, `ai-context`, or `none`.

## Setup on Santa (Jon)

Nothing here touches AWS. It needs the API deployed with this branch.

```bash
# 1. A Unix user for the bot, so the bot's files and Jon's (~/.config/lojo-mail) are separate.
sudo useradd --create-home --shell /bin/bash lojo-bot
sudo -u lojo-bot install -d -m 700 ~lojo-bot/.config/lojo-bot ~lojo-bot/lojo-bot-files

# 2. Install the bundle and a wrapper (from a checkout of this repo).
npm ci && npm run build:bot
sudo install -D -m 755 packages/bot/dist/lojo-bot.mjs /opt/lojo-bot/lojo-bot.mjs
sudo tee /usr/local/bin/lojo-bot >/dev/null <<'EOF'
#!/bin/sh
export LOJO_API_URL="${LOJO_API_URL:-https://<api-id>.execute-api.us-east-1.amazonaws.com}"
exec node /opt/lojo-bot/lojo-bot.mjs "$@"
EOF
sudo chmod 755 /usr/local/bin/lojo-bot

# 3. Create the credential (asks for your lojo-mail passphrase; prints no token).
#    Your choice from PR #12: trash, rules and test-send on top of the defaults.
lojo-bot admin create grok --out /tmp/grok.token --scopes read,write,body,trash,rules,test-send
#   chat-approved replies, only when you want them (see "Chat-approved replies"):
#   lojo-bot admin scopes grok --scopes read,write,body,trash,rules,test-send,send-approved
#   lojo-bot admin send-limits grok --per-hour 10 --per-day 30
sudo install -o lojo-bot -g lojo-bot -m 600 /tmp/grok.token ~lojo-bot/.config/lojo-bot/token && shred -u /tmp/grok.token

# 4. Optional: the bot envelope key, so the bot can read bodies.
sudo -u lojo-bot -H lojo-bot key generate > /tmp/bot.public.jwk
lojo-bot admin set-key /tmp/bot.public.jwk
lojo-bot admin backfill --private-key-file ~/.config/lojo-mail/envelope.private.jwk   # repeat until "0 without a copy"

# 5. Check.
sudo -u lojo-bot -H lojo-bot health      # bot:grok, its scopes, envelopeKey.matches true
```

`lojo-bot health` refuses to start if the token or key file is readable by group or others, or is owned by another user. `LOJO_API_URL` must be https (plain http is allowed only for localhost). Paths can be moved with `LOJO_BOT_HOME`, `LOJO_BOT_TOKEN_FILE`, `LOJO_BOT_KEY_FILE`, `LOJO_BOT_STATE_DIR` (digest cursor, default `~/.local/state/lojo-bot`) and `LOJO_BOT_ATTACH_DIR` (default `~/lojo-bot-files`).

## Registering the MCP server

On Santa (an MCP client running as the `lojo-bot` user):

```json
{ "mcpServers": { "lojo-mail": { "command": "lojo-bot", "args": ["mcp"] } } }
```

From the Grok Bot box, over ssh. Give the bot box its own ssh key, accepted only by the `lojo-bot` user and only for `lojo-bot`:

```bash
# On Santa: ~lojo-bot/.ssh/authorized_keys (one line)
restrict,command="/usr/local/bin/lojo-bot-ssh" ssh-ed25519 AAAA… grok-pm

# /usr/local/bin/lojo-bot-ssh (mode 755)
#!/bin/sh
set -f
case "$SSH_ORIGINAL_COMMAND" in
  "lojo-bot "*) exec /usr/local/bin/lojo-bot ${SSH_ORIGINAL_COMMAND#lojo-bot } ;;
  *) echo "only lojo-bot commands" >&2; exit 1 ;;
esac
```

```json
{ "mcpServers": { "lojo-mail": { "command": "ssh", "args": ["-T", "lojo-bot@santa", "lojo-bot", "mcp"] } } }
```

Tools are advertised only when the credential holds their scopes. Every result is wrapped with the untrusted-content notice.

| Tool | Scope | |
| --- | --- | --- |
| `health`, `settings`, `audit_log` | read | `audit_log mine:true` shows only this bot's events |
| `list_inbox`, `list_folder`, `search`, `list_labels`, `list_drafts`, `get_draft`, `list_rules`, `test_rules` | read | |
| `read_message`, `read_thread` | read (+ body for text) | `read_thread` marks the thread read |
| `digest` | read | see below |
| `mark_read`, `flag`, `set_labels`, `move_message` (inbox/archive/spam), `restore_message` | write | |
| `create_draft`, `draft_reply`, `update_draft`, `attach_file`, `remove_attachment`, `discard_draft`, `submit_for_approval` | write | `attach_file` reads only files under the attach directory (by real path, so symlinks out are refused), at most 4 MB, or base64 content |
| `disable_rule` | write | any rule off; only Jon turns his back on |
| `trash_message` | write + trash | |
| `upsert_rule`, `delete_rule` | rules | bot rules only; automated ones are saved disabled |
| `send_test_to_lojo_test` | test-send | only when Jon asks for a test send |
| `review_for_send` | read + send-approved | the exact content and `contentHash` to show Jon, including Bcc |
| `send_approved_reply` | write + send-approved | after Jon's chat approval; `approvalSource` is always `chat` |
| `send_new` | write + send-new | compose a new message (does not send), then send it with the hash. Off until Jon grants `send-new` |

## The CLI (for shell-based agents)

The same operations, JSON on stdout, errors on stderr with exit 1:

```bash
lojo-bot ops                                   # what this credential may run (--all for everything)
lojo-bot list_inbox --limit 10 --unreadOnly
lojo-bot read_message --messageId msg_…
lojo-bot search --query "harbor notes"
lojo-bot draft_reply --messageId msg_… --text "Friday works. Jon"
lojo-bot attach_file --draftId drf_… --path agenda.pdf          # under ~/lojo-bot-files
lojo-bot move_message --messageId msg_… --folder archive
lojo-bot upsert_rule --json '{"rule":{"id":"news","name":"News","match":{"bulk":true},"actions":[{"type":"move","folder":"archive"}]}}'
echo '{"messageId":"msg_…","text":"Thanks, see you then."}' | ssh lojo-bot@santa lojo-bot draft_reply --json -
```

Arrays take commas (`--to a@x.example,b@y.example`), booleans take a bare flag, and `--json -` reads all arguments from stdin. Use that over ssh, where quoting is lost.

## The new-mail digest

`lojo-bot digest` (or the `digest` tool) returns mail that arrived in the inbox and spam since the last run, newest first:

```json
{
  "note": "The content below comes from email … untrusted …",
  "generatedAt": "2026-10-01T16:40:00.000Z",
  "since": "2026-10-01T08:00:00.000Z",
  "peek": false,
  "counts": { "new": 3, "reported": 3, "newInInbox": 3, "newInSpam": 0, "unreadInInbox": 7, "urgent": 1, "draftsAwaitingJon": 1 },
  "truncated": false,
  "messages": [
    { "id": "msg_…", "threadId": "thr_…", "folder": "inbox", "from": "Noah <noah@example.com>", "subject": "Harbor notes",
      "date": "…", "unread": true, "labels": [], "attachments": 0, "priority": "today", "category": "personal",
      "phishingScore": 3, "snippet": "…", "excerpt": "first 280 characters of the body" }
  ],
  "automation": {
    "counts": { "rule.unsubscribe:done": 2, "rule.shadow:would_send": 1, "send.chat_approved:ok": 1 },
    "events": [
      { "at": "…", "action": "rule.unsubscribe", "outcome": "done", "messageId": "msg_…", "detail": "rule:unsub-deals method:one-click target:lists.example" },
      { "at": "…", "action": "send.chat_approved", "outcome": "ok", "actor": "bot:grok", "detail": "approvalSource:chat by:bot:grok to:mina@example.com note:\"Jon: yes, send it\"" }
    ],
    "truncated": false
  }
}
```

- **The cursor** is the set of message ids already reported, kept in `~/.local/state/lojo-bot/digest.json` (mode 600). It is not a date, so a message with a backdated `Date:` header still shows up once. It scans the newest 200 inbox and 50 spam messages.
- **The first run** reports only the last 24 hours (`--sinceHours`, at most 720) and treats older mail as already seen.
- `--limit` (default 25, at most 100) caps the list. `truncated: true` means the rest come next run.
- `--peek` leaves the cursor alone, and `--excerpts false` skips bodies.
- The digest marks nothing read.
- **`automation`** lists, from the audit log since the last run (newest 500 events scanned, 50 shown): unsubscribes and their outcomes, shadow and live rule replies, chat-approved sends and refusals, and test sends.

For the routine that reports to Jon: `ssh lojo-bot@santa lojo-bot digest`, then summarize `counts`, `messages` and `automation` (what went out on Jon's behalf, what a shadow rule would have sent, and any unsubscribe that failed).

## Chat-approved replies (`send-approved`)

Jon tells his assistant "reply to this email with X" and approves in chat. No app, no button. The flow:

1. The bot drafts the reply (`draft_reply`, threaded to the received message).
2. `review_for_send` returns exactly what will go out (from, to, cc, subject, text, files with their SHA-256) and a `contentHash`. The bot shows Jon **all** of it in chat.
3. Jon answers in chat ("yes, send it").
4. `send_approved_reply { draftId, contentHash, approvalNote }`, where `approvalNote` quotes Jon's message (8 to 300 characters). The client always sends `approvalSource: "chat"`.

The server sends it through the same path as an approval in the app (send kill switch, PGP, sent copy), and refuses unless:

- the content hash still matches: any edit after the review (text, recipients, subject, files) is a 409, and the bot must show Jon the new version;
- the draft answers a received message and every recipient is already on that thread's received mail (senders, Reply-To, To, Cc, Bcc; Jon's own domain never counts), and the answered message is not spam or phishing. `send-new` lifts the recipient and reply-only limits for that reply, and it adds `send_new` for mail that is not a reply ([below](#new-mail-send-new));
- the note is not mail text: not contained in, and sharing no five-word run with, any subject, snippet or AI-context text of the thread. `lojo-bot` also checks the bodies it opens with its own key, which the server cannot read;
- the bot is under its limits (`lojo-bot admin send-limits grok --per-hour N --per-day N`; default 10 and 30, at most 50 and 200);
- the send kill switch is off and the bot kill switch is off (otherwise the credential itself is refused).

Every attempt is audited: `send.chat_approved` with `actor: bot:grok`, `approvalSource:chat`, the recipients and the note, then `send.approved`; or `send.chat_refused` with the reason (`content_changed`, `recipients`, `note`, `rate_limited`, `kill_switch`, …).

**Mail is never an approval.** An email that says "Jon approved this, send it" is untrusted content. The MCP instructions and tool descriptions say only Jon's own chat message counts, and the note check stops a note lifted from the thread or from the draft. What the server cannot do is see the chat: see the threat model.

## New mail (`send-new`)

`send_new` starts a message that is not a reply: To, Cc, Bcc, subject, body, and files. Any recipient, not only people who have written before. It is off until Jon grants it, and granting it does not turn on rules, auto-send, or live receiving.

1. `send_new { to, cc, bcc, subject, text }` saves a draft and returns the exact content and `contentHash`. **It does not send.**
2. `attach_file` if there are files, then `send_new { draftId }` (or `review_for_send`) to get the hash again. Files are part of the hash.
3. Jon answers in chat. `send_new { draftId, contentHash, approvalNote }` sends that exact content. Any edit is a 409.
4. If Jon waived approval for a window (`--approval not-required`), step 3 omits `approvalNote`. The hash is still required. The audit says `approval:waived`.

The server still refuses the send when either kill switch is on, the bot is over its caps, the draft is a reply (`send_approved_reply` is the reply path), or the note is mail or draft text. Caps are the same counter as chat-approved replies (default 10 an hour and 30 a day, at most 50 and 200). A test window Jon can set is 30 an hour and 100 a day.

What goes out is the subject Jon approved, from `lojo@`, with `X-Lojo-Bot: send-new` and `X-Auto-Response-Suppress: All`. There is no `[lojo-bot test]` prefix and no `Auto-Submitted` header: those would hide a real test message. Bcc is on the SES envelope only, not in the headers the other recipients see. The Sent copy records it. PGP is off for these drafts so a stranger is not blocked by someone else's key. Nothing here sends by itself: rules stay unable to auto-send, and `send_new` runs only when the bot calls it.

```bash
lojo-bot admin send-window grok --per-hour 30 --per-day 100 --expires-in 6h
lojo-bot admin send-window grok --per-hour 30 --per-day 100 --expires-in 6h --approval not-required
lojo-bot admin send-limits grok --per-hour 10 --per-day 30 --expires none --approval required
lojo-bot admin send-window grok --revert
```

`--approval not-required` is refused without an expiry in the future, and the window cannot be longer than 30 days. When the expiry passes, the next bot or admin request turns `send-new` off and puts the caps back to 10 an hour and 30 a day. That revert is audited as `bot.send_grant_expired` with actor `system`. No scheduler: if nothing calls the API, the stored row waits, and the first call after the expiry applies it before the call is allowed to send.

A send is `bot.send_new` with actor `bot:grok`, the recipients (including Bcc), and either Jon's quote or `approval:waived`. Refusals are `bot.send_new_refused`. Both show up in the digest `automation` section.

## Automated rules: shadow first, unsubscribe, proposals

Jon's own rules can answer some mail without per-message approval (reply `mode: "autoSend"`, or an unsubscribe). The safety design is in [SECURITY.md](SECURITY.md#auto-send-guards); what is new:

- **Shadow first.** A rule that sends is saved in `shadow` mode first. Shadow runs every guard and limit, sends nothing, writes no draft, and audits what it would have sent (`rule.shadow` with a text preview, or `rule.unsubscribe` `shadow_would_send`). Only after that can the same rule go live; a save straight to live is refused.
- **Who:** only Jon's session writes, enables and promotes rules: the web app (Settings → Mail rules: **Enable**, **Go live**, **Shadow (log only)**, **Back to drafts**; each asks to confirm and names the rule's fingerprint, so a rule that changed meanwhile is refused) or `lojo-bot admin rule-enable <id>` / `rule-mode <id> draft|shadow|live` (prints the rule and needs you to type its id).
- **Limits:** a rule is limited to `allowSenders` (addresses or `@domains`), or, for a fixed plain-text template only, to `allowCategories` (for example `transactional` for receipt acknowledgements). Model-written text never auto-sends unless the rule sets `allowAiText: true`. Per-rule (`perSenderPerDay`, `perDay`) and global (`maxAutoSendPerDay`) limits, loop protection (no reply to auto-submitted, bulk, list or no-reply senders, once per message and per thread per day), and both kill switches apply as before.
- **Unsubscribe rules** detect `List-Unsubscribe` and send the request: RFC 8058 one-click (an HTTPS POST, preferred, sends no mail) or the `mailto:` address (a fixed request from the mailbox, recorded in Sent). Once per list per 30 days, `perDay` per rule (default 10). Outcomes are in the audit log and the digest; a done message is labelled `unsubscribed`.

  ```json
  { "id": "unsub-deals", "name": "Unsubscribe from deal lists", "match": { "from": ["@deals.example"], "bulk": true },
    "actions": [{ "type": "unsubscribe", "unsubscribe": { "mode": "shadow", "allowSenders": ["@deals.example"] } }] }
  ```
- **Bot proposals.** A bot with `rules` may `upsert_rule` a shadow reply or a shadow unsubscribe. It is saved `enabled: false` whatever the bot sends, shows as "bot proposal" in the web app, and does nothing until Jon enables it. Enabling makes it Jon's rule (`createdBy: human`): the bot can no longer edit it. The bot can never save `autoSend`, unsubscribe `auto`, or trash.
- **Deployment.** Live sending (auto-reply, mailto unsubscribe, one-click POST) still needs Terraform `auto_send_enabled = true`, which is off. Until then live rules are refused and audited; shadow works anywhere.

## Revoking, rotating, and the kill switch

All of these are Jon only, need his passphrase, take effect on the next request, and are audited (`bot.revoked`, `bot.rotated`, `bot.kill_switch`, `bot.scopes`, `bot.send_limits`, `bot.send_window`, `bot.envelope_key`):

```bash
lojo-bot admin list                                  # bots, scopes, created/rotated/revoked; never a token
lojo-bot admin revoke grok                           # that credential stops working
lojo-bot admin rotate grok --out /tmp/grok.token     # new credential; the old one stops working
lojo-bot admin scopes grok --scopes read,write       # narrow (or widen) scopes; removing send-approved stops chat sends
lojo-bot admin send-limits grok --per-hour 5 --per-day 15
lojo-bot admin send-window grok --per-hour 30 --per-day 100 --expires-in 6h
lojo-bot admin send-window grok --revert                 # send-new off, caps 10/h and 30/d
lojo-bot admin kill-switch on                        # every bot credential refused ("Bot access is switched off")
lojo-bot admin kill-switch off
lojo-bot admin remove-key                            # bots can no longer read any body copy
```

A revoked name can be created again with a new credential. The bot's past actions stay in the audit log under `bot:<name>`, and anything it trashed can be restored from Trash until the window ends. The send kill switch (`/v1/rules/switches`, also in the web app) stops test sends and chat-approved sends too. The bot kill switch is also a button in the web app: **Settings → Bots → Switch off all bots** (and **Allow bots again**), next to the list of bots, their scopes and send limits.

## Audit

Every bot request writes a `bot.request` audit event (`METHOD /path` and status, never a body, query string, or token) with `actor: bot:<name>`. Every event the mailbox writes during that request (`draft.created`, `message.trashed`, `rules.bot_upsert`, `bot.test_send`, …) also carries `actor`. The API's access log names the principal `bot:<name>`. `lojo-bot audit_log --mine` lists the bot's own events. The web app's Trash view shows "Trashed by bot grok".

## Threat model

**What the bot holds.**
- On Santa, under the `lojo-bot` user: the credential (`lbt_…`) and, optionally, the bot envelope private key.
- Never: Jon's passphrase, Jon's envelope key, the bridge token, or any AWS credential.

**What a stolen bot credential gives** (for example, Grok is prompt-injected by an email, or the bot box is compromised):
- Everything in the credential's scopes, and only those, until Jon revokes it or flips the kill switch.
- Mail metadata and, with `body`, AI-context text. With the bot key too, bodies.
- Without `send-approved`, it cannot send to anyone but lojo-test, and only with `test-send`, rate limited. With `send-approved`, see the next paragraph.
- It cannot approve drafts in the app, export, hard-delete, manage bots, enable or promote rules, or touch Jon's rules (beyond turning one off). Rules it proposes stay disabled until Jon enables them.
- Drafts it writes go only to existing contacts and still wait for Jon.
- It can trash at most 100 messages a day, all restorable, all recorded as `bot:<name>`.

**What `send-approved` adds: the approval is the bot's attestation.** The server never sees the chat between Jon and Grok. `approvalSource: "chat"` and the note are the bot's claim that Jon approved; the server cannot check that the claim is true. So a stolen credential with `send-approved`, or a model talked into it, can send replies Jon never approved, with a made-up note. What bounds that:
- Only replies to people already on a received thread (no new recipients, and no brand-new message, without `send-new`), and never to spam or phishing.
- Only the content the bot itself reviewed (hash); it cannot send a draft Jon edited elsewhere without reviewing again.
- The note cannot be lifted from the mail, so an email cannot supply its own "approval" text. A model can still invent one.
- At most the per-bot limit (default 10 an hour, 30 a day), then 429.
- Every send is audited with actor, `approvalSource:chat` and the note, and listed in the digest. Removing the scope, the bot kill switch (web app or CLI) or the send kill switch stops it on the next request.

Grant `send-approved` only when the chat channel to Grok is one only Jon can write to, and Grok's other inputs (mail, web pages) cannot pose as Jon. Keep `send-new` off unless needed: without it the worst case is an unwanted reply to someone who already wrote to Jon.

**What `send-new` adds.** The bot can address anyone, including people who have never written, and can Bcc them. With approval required (the default), it is the same attestation as `send-approved`: the server checks the hash, the note, the caps, and both kill switches, and it cannot see the chat. With `--approval not-required`, the note is skipped until `expiresAt`. That waiver cannot be saved without an expiry, and the expiry also puts the caps back to 10 an hour and 30 a day and turns `send-new` off. A stolen credential during that window can send up to the raised caps without a quote. The hash still binds the bytes, both kill switches still stop it, and every send is audited as `approval:waived`. It does not let a rule send, and it does not change `receiving_stage` or `auto_send_enabled`.

**What the bot key adds.** Anyone with the bot private key and the credential can read the bot's body copies, which, after a backfill, means most of the mailbox. That is the price of a bot that reads bodies, so it is opt-in. Keep the key under the `lojo-bot` user only. Removing the key on the server ends access even if the private key leaks. Without the credential, the private key alone opens nothing, because copies are only served to an authenticated bot.

**Prompt injection.**
- Results are wrapped as untrusted.
- The MCP instructions tell the model never to follow instructions in mail.
- The tools are built so that obeying an injected instruction can still not send mail to an outsider.
- `attach_file` reads only the attach directory, so an email cannot make the bot attach `~/.ssh/id_ed25519` or its own key to a draft. Even so, a draft could still quote mail content to a known correspondent: Jon reviews every draft before Send.
- Bot rules can archive, label, mark read, move to spam, and draft replies. They cannot trash or auto-send. An injected email can make the bot propose a shadow rule, but it is saved disabled, Jon sees it as a proposal with its exact content before enabling it, and it must run in shadow before it can go live.

**The Unix boundary.** The bot's files are only as private as the `lojo-bot` user. If Grok's shell on Santa runs as **Jon's** user, it can read `~/.config/lojo-mail` (Jon's key and the bridge token) directly, and the bot credential is not a boundary. Give Grok shell only as `lojo-bot` (the forced-command ssh key above), not as Jon.

**Server side.** The registry is a single DynamoDB item, `bots:registry` in the budget table. It holds hashes, scopes, timestamps, the kill switch, and the bot public key, and it is saved with an optimistic version check. An attacker with write access to that table could add a bot; that is the same AWS access that already reaches every other table, and outside this design.

## What changed in AWS

**No Terraform or IAM change.**
- The registry lives in the existing budget table, which the API and processor roles already read and write.
- Bot copies are new S3 objects under the existing `objects/*` prefix: the processor and API already write there, the API reads, and the purge deletes.
- The test send and chat-approved sends use the API's existing SES grant (the same `approveAndSend` path as Jon's own approvals).
- Rule promotion, shadow mode and bot proposals live in the existing sealed rules document.
- Unsubscribe by mailto uses the processor's SES grant that `auto_send_enabled` already adds (constrained to the mailbox as `ses:FromAddress`). Unsubscribe by one-click is **new outbound HTTPS from the processor Lambda**, also only when `auto_send_enabled` is on. The processor is not in a VPC, so no network or IAM change is needed, but it is new egress to third-party URLs taken from list mail (filtered as described in [SECURITY.md](SECURITY.md#unsubscribe-rules)).
- `auto_send_enabled` stays `false`; nothing here turns it on.

Expect one extra small S3 object per message once a bot key is registered (about the size of the sealed body).

## Deploying `send-new` (Lambda code only)

This change does not touch Terraform resources, IAM, DNS, the SES receipt rule, `receiving_stage`, or `auto_send_enabled`. `lojo@` stays in test mode. Auto-send and rules stay off. The registry row is the same budget-table item as before; the new fields (`sendGrant`, draft `bcc`, draft `sendNew`) are stored on records the API already writes.

The API Lambda bundles `@lojo/core`, and the processor Lambda bundles the SES sender and the MIME builder, so a plan can show an in-place code update for `aws_lambda_function.api` and `aws_lambda_function.processor`. `trash_purge` changes only if its bundle hash moves. Environment variables, roles, and concurrency stay as they are.

Do not apply until the plan is only those function code updates. Reject the plan if it wants to change `receiving_stage`, `auto_send_enabled`, a receipt rule, IAM, or DNS.

```bash
npm ci
npm test
npm run build:lambda
cd infra/terraform
terraform plan
# Expect: aws_lambda_function.api (and processor if its zip hash moved) update in place.
# Then, and only then: terraform apply
```

After the apply, on Santa, install the new `lojo-bot` bundle (`npm run build:bot`, then the install lines in [Setup on Santa](#setup-on-santa-jon)) and run `scripts/santa/grant-send-new.sh`. That script asks for the passphrase and does not call AWS. `scripts/santa/rollback-send-new.sh` turns the window off. Copy `docs/lojo-bot-USAGE.txt` to `/home/jon/lojo-bot-USAGE.txt` (the grant script does this when that home directory exists).

## Decisions for Jon

Decided in PR #12: bot key and backfill, scopes `trash`, `rules` and `test-send`, a restricted `lojo-bot` Unix user on Santa, and a web-app kill-switch button (done: Settings → Bots). Still open:

1. **`send-approved` for Grok, and its limits.** Off until you run `lojo-bot admin scopes … send-approved`. Defaults 10 an hour, 30 a day. Read the attestation tradeoff in the threat model first.
2. **`send-new`.** Recommended off. With it, `send_new` can mail anyone, and a chat-approved reply can add people who were not on the thread. A time-boxed window (30/hour, 100/day, optional approval waiver) reverts on its own. Scripts: `scripts/santa/grant-send-new.sh` and `scripts/santa/rollback-send-new.sh`.
3. **Which automated rules, and when.** Nothing is enabled. Suggested order: an unsubscribe rule limited to a few list domains in shadow, a template receipt acknowledgement in shadow, review the shadow log (digest `automation`), then turn on `auto_send_enabled` in Terraform and take the rules live.
4. **Category-only template rules.** A fixed template may be limited to `allowCategories` instead of `allowSenders`. The category comes from the model and can be steered by an email, so such a rule can answer any DMARC-passing sender with your fixed text, within its rate limits. Prefer `allowSenders` where you can.
5. **One-click unsubscribe egress.** With `auto_send_enabled`, the processor POSTs to https URLs from list headers (filtered, no redirects). If you would rather never let the processor reach third-party URLs, use mailto only: say so and one-click can be made a separate flag.
