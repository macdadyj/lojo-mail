# Jon's bot on lojo-mail (`lojo-bot`)

`lojo-bot` lets Jon's Grok Bot assistant (the Project Manager agent) manage the mailbox from Santa Computa: read, search, sort, label, move to Trash, run its own sort rules, and write drafts and replies with attachments. It cannot send to anyone. Drafts go to Jon, who presses Send in Thunderbird or the web app. The one exception is a test message to `lojo-test@cyberphysical.us`, and only when Jon grants that scope.

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
| `rules` | no | add, replace and delete **its own** rules (`createdBy: bot`). Never one of Jon's rules, never a `trash` action, never auto-send. Jon's switches and limits are untouched |
| `test-send` | no | `send_test_to_lojo_test`: plain text to `lojo-test@cyberphysical.us` and nobody else (hard-coded), subject prefixed `[lojo-bot test] `, at most 5,000 characters, 5 an hour and 20 a day per bot, stopped by the send kill switch, marked `Auto-Submitted` |

`admin` does not imply `rules` or `test-send`, and neither can be given to an ordinary API token. A bot can never approve or send a draft, use `/v1/client/send`, export the mailbox, replace the rules document, release a kill switch, or manage bots. Those routes need Jon's session.

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
lojo-bot admin create grok --out /tmp/grok.token                # default scopes: read,write,body
#   add more only if you want them:  --scopes read,write,body,trash,rules,test-send
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
| `upsert_rule`, `delete_rule` | rules | bot rules only |
| `send_test_to_lojo_test` | test-send | only when Jon asks for a test send |

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
  ]
}
```

- **The cursor** is the set of message ids already reported, kept in `~/.local/state/lojo-bot/digest.json` (mode 600). It is not a date, so a message with a backdated `Date:` header still shows up once. It scans the newest 200 inbox and 50 spam messages.
- **The first run** reports only the last 24 hours (`--sinceHours`, at most 720) and treats older mail as already seen.
- `--limit` (default 25, at most 100) caps the list. `truncated: true` means the rest come next run.
- `--peek` leaves the cursor alone, and `--excerpts false` skips bodies.
- The digest marks nothing read.

For the routine that reports to Jon: `ssh lojo-bot@santa lojo-bot digest`, then summarize `counts` and `messages`.

## Revoking, rotating, and the kill switch

All of these are Jon only, need his passphrase, take effect on the next request, and are audited (`bot.revoked`, `bot.rotated`, `bot.kill_switch`, `bot.scopes`, `bot.envelope_key`):

```bash
lojo-bot admin list                                  # bots, scopes, created/rotated/revoked; never a token
lojo-bot admin revoke grok                           # that credential stops working
lojo-bot admin rotate grok --out /tmp/grok.token     # new credential; the old one stops working
lojo-bot admin scopes grok --scopes read,write       # narrow (or widen) scopes
lojo-bot admin kill-switch on                        # every bot credential refused ("Bot access is switched off")
lojo-bot admin kill-switch off
lojo-bot admin remove-key                            # bots can no longer read any body copy
```

A revoked name can be created again with a new credential. The bot's past actions stay in the audit log under `bot:<name>`, and anything it trashed can be restored from Trash until the window ends. The send kill switch (`/v1/rules/switches`, also in the web app) stops test sends too. The bot kill switch is CLI only for now.

## Audit

Every bot request writes a `bot.request` audit event (`METHOD /path` and status, never a body, query string, or token) with `actor: bot:<name>`. Every event the mailbox writes during that request (`draft.created`, `message.trashed`, `rules.bot_upsert`, `bot.test_send`, …) also carries `actor`. The API's access log names the principal `bot:<name>`. `lojo-bot audit_log --mine` lists the bot's own events. The web app's Trash view shows "Trashed by bot grok".

## Threat model

**What the bot holds.**
- On Santa, under the `lojo-bot` user: the credential (`lbt_…`) and, optionally, the bot envelope private key.
- Never: Jon's passphrase, Jon's envelope key, the bridge token, or any AWS credential.

**What a stolen bot credential gives** (for example, Grok is prompt-injected by an email, or the bot box is compromised):
- Everything in the credential's scopes, and only those, until Jon revokes it or flips the kill switch.
- Mail metadata and, with `body`, AI-context text. With the bot key too, bodies.
- It cannot send to anyone but lojo-test, and only with `test-send`, rate limited.
- It cannot approve drafts, export, hard-delete, manage bots, or touch Jon's rules (beyond turning one off).
- Drafts it writes go only to existing contacts and still wait for Jon.
- It can trash at most 100 messages a day, all restorable, all recorded as `bot:<name>`.

**What the bot key adds.** Anyone with the bot private key and the credential can read the bot's body copies, which, after a backfill, means most of the mailbox. That is the price of a bot that reads bodies, so it is opt-in. Keep the key under the `lojo-bot` user only. Removing the key on the server ends access even if the private key leaks. Without the credential, the private key alone opens nothing, because copies are only served to an authenticated bot.

**Prompt injection.**
- Results are wrapped as untrusted.
- The MCP instructions tell the model never to follow instructions in mail.
- The tools are built so that obeying an injected instruction can still not send mail to an outsider.
- `attach_file` reads only the attach directory, so an email cannot make the bot attach `~/.ssh/id_ed25519` or its own key to a draft. Even so, a draft could still quote mail content to a known correspondent: Jon reviews every draft before Send.
- Bot rules can archive, label, mark read, move to spam, and draft replies. They cannot trash or auto-send.

**The Unix boundary.** The bot's files are only as private as the `lojo-bot` user. If Grok's shell on Santa runs as **Jon's** user, it can read `~/.config/lojo-mail` (Jon's key and the bridge token) directly, and the bot credential is not a boundary. Give Grok shell only as `lojo-bot` (the forced-command ssh key above), not as Jon.

**Server side.** The registry is a single DynamoDB item, `bots:registry` in the budget table. It holds hashes, scopes, timestamps, the kill switch, and the bot public key, and it is saved with an optimistic version check. An attacker with write access to that table could add a bot; that is the same AWS access that already reaches every other table, and outside this design.

## What changed in AWS

**No Terraform or IAM change.**
- The registry lives in the existing budget table, which the API and processor roles already read and write.
- Bot copies are new S3 objects under the existing `objects/*` prefix: the processor and API already write there, the API reads, and the purge deletes.
- The test send uses the API's existing SES grant.

Expect one extra small S3 object per message once a bot key is registered (about the size of the sealed body).

## Decisions for Jon

1. **Bot envelope key and backfill.** Without a key the bot reads metadata, snippets, and AI-context text only. With a key and a backfill it reads every body. Both are opt-in, and removing the key revokes the access.
2. **Scopes for Grok.** The default is `read,write,body`. Add `trash`, `rules`, and `test-send` only if wanted.
3. **How Grok reaches Santa.** Recommended: ssh as `lojo-bot` with a forced command. If Grok already has a shell as you, the bot boundary does not protect your key.
4. **Kill switch reach.** The bot kill switch is CLI only (`lojo-bot admin kill-switch on`). The web app does not have a button for it yet; say if you want one.
5. **Autonomous send.** It is not part of this. Bot rules cannot auto-send. Your existing opt-in auto-send rules (listed senders, rate limits, loop protection, kill switch) remain the only path, and only you can turn them on.
