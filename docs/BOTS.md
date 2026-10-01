# Bots managing your mail

Grok Bot, Grok Build, Cursor, grok.com, and local models (Ollama through `lojo-local`) can work Jon's mailbox for him: read, search, sort, label, move, delete to Trash, and write replies. They cannot send. Every reply a bot writes lands as a **draft** in Thunderbird's Drafts folder (and the web app's Drafts view). Jon opens it, edits it if he wants, and presses **Send** in Thunderbird. That Send is the approval.

```text
bot (MCP / lojo-local) ──agent token──▶ lojo-mail API ──▶ draft (origin agent)
                                                            │
Thunderbird Drafts ◀── bridge (IMAP) ◀──────────────────────┘
      │ Jon presses Send
      ▼
bridge (SMTP, client-send) ──▶ API ──▶ SES        draft marked sent, "unchanged" or "edited" recorded
```

For Jon's own Grok Bot running on Santa Computa, prefer [BOT.md](BOT.md): a bot credential Jon creates and revokes from the CLI (effective on the next request, global kill switch), an opt-in bot envelope key for bodies, and a stdio MCP server and CLI (`lojo-bot`). The agent tokens below remain for remote-MCP clients.

## What a bot can and cannot do

| | Agent token (any bot) | Thunderbird bridge (Jon) | Jon's web session |
| --- | --- | --- | --- |
| Read, search, list folders and drafts | `read` (bodies with `body`) | yes | yes |
| Label, archive, move to inbox/archive/spam, restore from Trash | `write` | yes | yes |
| Delete to Trash (soft, restorable for the retention window) | only with `trash` on that token, max 100 per bot per day | with `bridge_trash_enabled` | yes |
| Write and edit drafts | `write`, to known correspondents only | yes, to anyone | yes |
| Send | **never** | yes (`client-send`), rate limited | through approval |
| Hard delete | **never** (no route exists) | never | never; only the scheduled purge after the window |
| Change rules, enable auto-send, release kill switches | **never** | never | yes |
| Engage the global send kill switch, pause rules | yes (can only make things safer) | yes | yes |

The agent token's label is the principal: every action is logged as `agent:<label>`, and the web app's Trash view shows "Trashed by agent grok-bot". The bridge credential is a different principal (`bridge`) with a scope, `client-send`, that no agent token can hold: the API refuses it in the agent-token list, `admin` does not imply it, and `/mcp` answers 403 to any token that holds it. So a bot cannot pretend to be Jon at Thunderbird.

## 1. Tokens: one per bot

Agent tokens live in one SSM SecureString, `/lojo-mail/agent-tokens`, as a JSON array. One entry per bot, so each can be revoked alone. Suggested set:

```json
[
  { "label": "grok-bot",   "token": "<openssl rand -hex 32>", "scopes": ["read", "write", "body"] },
  { "label": "grok-build", "token": "<openssl rand -hex 32>", "scopes": ["read", "write", "body"] },
  { "label": "grokcom",    "token": "<openssl rand -hex 32>", "scopes": ["read", "write"] },
  { "label": "cursor",     "token": "<openssl rand -hex 32>", "scopes": ["read", "write", "body", "trash"] },
  { "label": "local",      "token": "<openssl rand -hex 32>", "scopes": ["read", "write", "body", "trash"] }
]
```

```bash
aws ssm put-parameter --region us-east-1 --name /lojo-mail/agent-tokens \
  --type SecureString --overwrite --value file://agent-tokens.json
shred -u agent-tokens.json
```

- `read` lists and searches; `write` sorts and drafts; `body` shows message text (so the bot's model provider sees it); `trash` allows soft delete. `send`, `admin`, `compose` and `client-send` are refused for agent tokens; if any entry asks for one, no agent token loads (`agent_tokens_invalid` in the API log).
- `body` on a Grok token sends mail text to xAI. `body` on the local token keeps it between the API and Jon's machines.
- The API reloads within 5 minutes. Keep each token in that bot's own secret store (environment, `pass`, the bot's config), never in a repository.

Replace `https://<api>` below with `terraform output api_endpoint`.

## 2. Grok Bot (xAI API with remote MCP)

A Grok bot is any program that calls xAI's Responses API with lojo-mail as a remote MCP tool. xAI's servers call `https://<api>/mcp` with the bearer token.

```bash
export LOJO_GROK_BOT_TOKEN="<grok-bot token>"
curl https://api.x.ai/v1/responses \
  -H "Authorization: Bearer $XAI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.3",
    "input": "Sort my inbox: label anything from my landlord todo, archive newsletters, and draft a short yes to Mina about Friday.",
    "tools": [{
      "type": "mcp",
      "server_label": "lojo_mail",
      "server_url": "https://<api>/mcp",
      "authorization": "Bearer '"$LOJO_GROK_BOT_TOKEN"'"
    }]
  }'
```

Add `"allowed_tools": [...]` to narrow further on xAI's side. The server's scopes are the real limit either way. For a scheduled bot, run the same call from a cron job or systemd timer on Santa with the token in `pass`.

## 3. Grok Build (CLI)

`~/.grok/config.toml`:

```toml
[mcp_servers.lojo-mail]
url = "https://<api>/mcp"
enabled = true
headers = { "Authorization" = "Bearer ${LOJO_GROK_BUILD_TOKEN}" }
```

Export `LOJO_GROK_BUILD_TOKEN` in the shell that starts `grok`. Ask it "list my lojo inbox" to check. The tools it can see are `search_mail`, `list_inbox`, `list_folder`, `list_drafts`, `read_thread`, `label_message`, `move_message`, `archive_message`, `create_draft`, `draft_reply`, and the rest your scopes allow.

## 4. Cursor (MCP)

Two snippets in [`integrations/cursor/`](../integrations/cursor); merge one into `~/.cursor/mcp.json`.

- **Local stdio** ([`mcp.json`](../integrations/cursor/mcp.json)): runs `packages/mcp` from a checkout. Export `LOJO_API_URL=https://<api>` and `LOJO_CURSOR_TOKEN=<cursor token>` before starting Cursor, and set `LOJO_API_SCOPES` in the snippet to the scopes you want Cursor to use, for example `"read,write,body,trash"`. Cursor gets the intersection of that and the token's scopes.
- **Remote** ([`mcp.remote.json`](../integrations/cursor/mcp.remote.json)): points at `https://<api>/mcp` with the `Authorization` header. Nothing runs locally; the token's scopes apply.

Check: Cursor's MCP settings list `lojo-mail`, with `trash_message` only if the token has `trash`. `trash_message` carries the MCP `destructiveHint`, so clients that honour it (Cursor does) ask before calling it.

## 5. grok.com

grok.com → Connectors → New Connector → Custom → URL `https://<api>/mcp`. lojo-mail authenticates with a static bearer token. If the form has an API-key or custom-header field, put `Bearer <grokcom token>` there. If it only offers OAuth, grok.com cannot connect yet; use Grok Build or a Grok Bot instead. This path is untested: there is no deployed endpoint to try it against, and the connector form may have changed.

## 6. Local models: Ollama / Llama (`lojo-local`)

Runs on Jon's machine; the model is Ollama on labMachine (`http://100.96.1.90:11434`) over the tailnet, so mail text never reaches a cloud model.

```bash
export LOJO_API_URL="https://<api>"
export LOJO_API_TOKEN="$(pass show lojo/local-agent-token)"
export LOJO_API_SCOPES="read,write,body,trash"
export OLLAMA_URL="http://100.96.1.90:11434"
export LOJO_LOCAL_MODEL="llama3.2:3b"           # qwen2.5:3b also calls tools well

npm run local -- whoami                          # effective scopes
npm run local -- inbox --triage
npm run local -- folder archive --limit 20
npm run local -- label msg_… todo personal       # replaces the labels
npm run local -- move msg_… archive
npm run local -- trash msg_…                     # soft delete; restore with: npm run local -- restore msg_…
npm run local -- draft thr_… --local --instruction "say Friday works"   # lands in Thunderbird Drafts
npm run local -- drafts
npm run local -- ask "archive this week's newsletters and draft replies to anything personal"
```

`ask` lets the model pick tools itself (the same catalog as MCP). The explicit commands do exactly one thing each and do not involve the model.

## 7. Reviewing and sending a bot's draft

1. In Thunderbird, open **Drafts**. Bot drafts carry the tag `bot-draft` (Thunderbird shows it as a tag; add a colour under Settings → General → Tags, or a saved search on it).
2. Double-click the draft (or Edit Draft). Thunderbird opens it in the composer with the right recipients and reply headers.
3. Edit anything. Add attachments, Cc, or Bcc if you want: the message goes out as you send it.
4. Press **Send**. The bridge sends through SES with the bridge credential; the service marks the bot's draft sent and records whether you sent it unchanged or edited. The draft leaves Drafts and the message appears in Sent.

To reject a draft, delete it in Thunderbird. It is discarded (audited), never sent.

## 8. Fully autonomous sending (opt-in, off by default)

Agent tokens never send. (A `lojo-bot` credential with `send-approved` can send replies Jon approved in chat; see [BOT.md](BOT.md#chat-approved-replies-send-approved).) The only automatic sending is a **rule** Jon writes himself, with `mode: "autoSend"` or an unsubscribe in `mode: "auto"`:

- Only Jon's signed-in session can write rules (`npm run rules -- push`, passphrase and a typed `yes`), enable them, or take them live. No token, including `admin`, the bridge, and every agent token, can write rules or turn auto-send on. Agents can only pause rules, engage the kill switches, or disable a rule.
- A rule runs in `shadow` mode first (logs what it would send, sends nothing); a save that goes straight to live is refused.
- Terraform `auto_send_enabled = true` is also required (default false).
- Each auto-send rule needs an explicit `allowSenders` list (only those authenticated, DMARC-pass senders get answers), or a fixed template limited to `allowCategories`. Model-written text needs `allowAiText: true` on the rule.
- Loop protection refuses auto-replies, mailing lists, bulk mail, `noreply`-style senders, `Auto-Submitted`, and Reply-To redirection (unsubscribe rules answer list mail by design, with their own guards).
- Rate limits per sender, per rule, and per day across all rules.
- Two kill switches: the auto-send kill switch (rules reply as drafts instead), and the global send kill switch, which stops auto-send, approved sends and Thunderbird sends together. Any bot may engage either; only Jon can release them (web app → Rules).

Details and the full guard list: [SECURITY.md](SECURITY.md#auto-send-guards) and [unsubscribe rules](SECURITY.md#unsubscribe-rules).

## 9. Revoking a bot

Remove its entry from `/lojo-mail/agent-tokens` (or replace its token) and put the parameter again. The API stops accepting it within 5 minutes. Its past actions stay in the audit log under `agent:<label>`, and anything it trashed is restorable from Trash until the retention window ends.
