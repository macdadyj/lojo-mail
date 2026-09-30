# Integrations: Cursor, Grok, local models, and AI providers

Three ways to search and work the mailbox from an assistant, and one switch for which model the server itself uses. All of them go through the same HTTP API with a scoped bearer token, so the rules are the same everywhere:

- No assistant can send. There is no send tool. Sending needs the `send` scope **and** a one-time approval token that only Jon's signed-in web session can mint for that exact content ([SECURITY.md](SECURITY.md#human-approval-for-sending)). The most an assistant can do is `submit_for_approval`, which puts a draft in the web app's approval queue.
- Message text (bodies, AI summaries, action items, semantic search) needs the `body` scope. Without it a token sees headers, labels, and the short snippet.
- Trash, full export, and approval are human-only. No token reaches them.
- Every tool result is wrapped as untrusted content, because it is mail that anyone can write.

| Client | Transport | Where it runs | Default scopes |
| --- | --- | --- | --- |
| Cursor | stdio MCP server (`packages/mcp`) or remote MCP at `/mcp` | Jon's machine / API Gateway | `read` |
| Grok (xAI API, Grok Build, grok.com) | remote MCP at `POST /mcp`, Streamable HTTP | xAI's servers call the API | `read` |
| Local models (Ollama, llama.cpp, vLLM, LM Studio) | `lojo-local` CLI and tool-calling adapter (`packages/local`) | Jon's machine | whatever the token has, narrowed by `LOJO_API_SCOPES` |

## Tokens: one per client

Give every client its own token so it can be revoked alone. Every request is logged to the API's CloudWatch log group as an `api_request` line with the token's label (`agent:cursor`), method, path, and status; never the token, a body, or a query string. Agent tokens live in one SSM SecureString, `/lojo-mail/agent-tokens`, as a JSON array:

```json
[
  { "label": "cursor", "token": "<openssl rand -hex 32>", "scopes": ["read"] },
  { "label": "grok",   "token": "<openssl rand -hex 32>", "scopes": ["read"] },
  { "label": "local",  "token": "<openssl rand -hex 32>", "scopes": ["read", "write", "body"] }
]
```

```bash
aws ssm put-parameter --region us-east-1 --name /lojo-mail/agent-tokens \
  --type SecureString --value file://agent-tokens.json
shred -u agent-tokens.json
```

Rules the API enforces when it loads the list:

- Scopes are limited to `read`, `write`, and `body`. `send` and `admin` are refused for agent tokens.
- Tokens are at least 32 characters. Labels are 1–32 lowercase letters, digits, or dashes, and unique. A token acts as `agent:<label>`.
- If any entry breaks a rule, **no** agent token works, and the API logs `agent_tokens_invalid` with the reason (never the token). The web app and the main API token keep working, so a typo cannot lock Jon out.
- The API reloads its parameters every 5 minutes (`LOJO_CONFIG_TTL_MS`), so adding or revoking a token takes effect within 5 minutes. To apply it at once, force a cold start: `aws lambda update-function-configuration --function-name lojo-mail-api --description "rotate $(date +%s)"`.

Which scopes to grant:

| Scope | Adds | Consider it for |
| --- | --- | --- |
| `read` | inbox, triage, threads and search over metadata and snippets, labels, drafts list | every client |
| `write` | labels, archive, move (not to trash), create and edit drafts, `draft_reply` and `summarize_thread` (these spend model tokens), `submit_for_approval` | clients that should triage or draft |
| `body` | message text, AI summaries, action items, semantic search | only clients whose model provider you are content to show mail text to |

`body` on the Grok token means mail text goes to xAI. `body` on the local token keeps text between the API and Jon's own machine.

For local development, `npm run dev` accepts `LOJO_AGENT_TOKENS` with the same JSON and prints the dev tokens (`dev-read-only` is read-only). Dev tokens are refused when `NODE_ENV=production`.

## Cursor

Two snippets, both in [`integrations/cursor/`](../integrations/cursor). Merge one into `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project). Neither contains a secret: Cursor fills `${env:NAME}` from the environment it was started in.

**Local stdio (recommended).** [`mcp.json`](../integrations/cursor/mcp.json) runs the MCP server from a checkout of this repo, talking to the API over HTTPS. Replace `/ABSOLUTE/PATH/TO/lojo-mail` (run `npm ci` there once), then export the variables before starting Cursor:

```bash
export LOJO_API_URL="https://<api-id>.execute-api.us-east-1.amazonaws.com"   # terraform output api_endpoint
export LOJO_CURSOR_TOKEN="<the cursor agent token>"
```

`LOJO_API_SCOPES` is `read` in the snippet. The server asks the API which scopes the token really has, uses the intersection, and lists only the tools that intersection allows. To let Cursor draft, grant the token `write` and change the snippet to `"read,write"`; either side alone is not enough.

**Remote.** [`mcp.remote.json`](../integrations/cursor/mcp.remote.json) points Cursor straight at `https://<api>/mcp` with an `Authorization` header. Nothing runs locally. The scopes are the token's own.

Check it: Cursor's MCP settings should show `lojo-mail` with `search_mail`, `read_thread`, `list_inbox`, and `export_mailbox` for a read token. Ask "what's in my lojo inbox?".

## Grok

The API serves MCP at `POST /mcp` (stateless Streamable HTTP, JSON responses, protocol versions 2025-06-18, 2025-03-26, 2024-11-05). It takes bearer API or agent tokens only; a web session token gets 403, and a request carrying a browser `Origin` gets 403. xAI calls it from xAI's servers, so the API has to be on the public internet. The API Gateway URL already is. Use HTTPS only.

**xAI API (Responses API or the xAI SDK).** Confirmed in xAI's [Remote MCP Tools](https://docs.x.ai/developers/tools/remote-mcp) docs (checked 30 Sep 2026):

```bash
curl https://api.x.ai/v1/responses \
  -H "Authorization: Bearer $XAI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.3",
    "input": "Anything from the landlord this week? Summarize it.",
    "tools": [{
      "type": "mcp",
      "server_label": "lojo_mail",
      "server_url": "https://<api-id>.execute-api.us-east-1.amazonaws.com/mcp",
      "authorization": "Bearer '"$LOJO_GROK_TOKEN"'",
      "allowed_tools": ["search_mail", "list_inbox", "read_thread"]
    }]
  }'
```

`allowed_tools` (`allowed_tool_names` in the xAI Python SDK) narrows further on xAI's side. The server's scopes are the real limit. xAI ignores `require_approval`, which does not matter here: approval is enforced by the lojo-mail server, not by the client.

**Grok Build (the CLI).** `~/.grok/config.toml`, with the token from the environment:

```toml
[mcp_servers.lojo-mail]
url = "https://<api-id>.execute-api.us-east-1.amazonaws.com/mcp"
enabled = true
headers = { "Authorization" = "Bearer ${LOJO_GROK_TOKEN}" }
```

**grok.com connectors.** grok.com → Connectors → New Connector → Custom → paste `https://<api>/mcp`, then "complete any required authentication" ([xAI connectors docs](https://docs.x.ai/grok/connectors)). lojo-mail authenticates with a static bearer token, not OAuth. If the connector form offers an API-key or header field, use the Grok agent token there. If it only offers OAuth, this path does not work yet; use the API or Grok Build. Not tested from here, because there is no deployed endpoint.

Check it without Grok:

```bash
curl -s https://<api>/mcp -H "Authorization: Bearer $LOJO_GROK_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Local models: Ollama and friends

`packages/local` is a small CLI plus a tool-calling adapter. It works against the same API with the same scopes and has no send path. The model runs wherever you point it. By default that is Ollama on labMachine at `http://100.96.1.90:11434`, reachable over the tailnet.

```bash
export LOJO_API_URL="https://<api>"          # or http://127.0.0.1:8787 for npm run dev
export LOJO_API_TOKEN="<the local agent token>"
export LOJO_API_SCOPES="read,write,body"      # narrowed to what the token has
ollama pull llama3.2:3b                        # on labMachine; 1b works for summaries, 3b calls tools better

npm run local -- whoami                        # identity and effective scopes
npm run local -- inbox --triage
npm run local -- search "lease renewal" --semantic
npm run local -- read thr_…
npm run local -- summarize thr_… --local       # summarized on Ollama; the text never reaches a cloud model
npm run local -- draft thr_… --local --instruction "decline politely"   # goes to Drafts
npm run local -- draft thr_… --local --submit  # also queues it for Jon's approval
npm run local -- ask "who still owes me a reply?"   # the model picks tools itself
npm run local -- backfill --limit 25           # embed older mail for semantic search (write + body)
```

| Variable | Default | |
| --- | --- | --- |
| `LOJO_LOCAL_BACKEND` | `ollama` | or `openai` for any OpenAI-compatible server |
| `OLLAMA_URL` | `http://100.96.1.90:11434` | |
| `LOJO_LOCAL_MODEL` | `llama3.2:1b` | `llama3.2:3b` or `qwen2.5:3b` for `ask` |
| `LOJO_LOCAL_OPENAI_URL`, `LOJO_LOCAL_OPENAI_KEY` | | llama.cpp `llama-server`, vLLM, LM Studio |
| `LOJO_MAILBOX` | `lojo@cyberphysical.us` | so a reply skips Jon's own messages |

The adapter is reusable. `runAgent` (`packages/local/src/agent.ts`) takes any `ChatBackend` (`OllamaChat` or `OpenAiChat` in `chat.ts`). It offers the model only the tools the token's scopes allow, the same catalog the MCP server uses, and runs each call through the REST API with that token. Tool results reach the model wrapped as untrusted content. A tool the model is not allowed to call fails server-side with "Missing … scope".

Without `--local`, `summarize` and `draft <messageId>` ask the server's own provider (below) and spend the daily token budget.

## Server-side AI providers

The processor (ingest analysis, embeddings) and the API (draft reply, rewrite, summarize, semantic query) pick a chat provider and an embedding provider independently. In Terraform:

| `llm_provider` | Talks to | Key | Model variable (default) |
| --- | --- | --- | --- |
| `grok` | xAI, OpenAI-compatible `/chat/completions` | SSM `/lojo-mail/grok-api-key` | `grok_model` (`grok-3-mini`; see COSTS_COMPARE.md, it may be retired) |
| `bedrock` | Bedrock `Converse` | IAM role | `bedrock_model_id` (Claude Haiku 4.5) |
| `openai` | any OpenAI-compatible endpoint (`openai_base_url`) | SSM `/lojo-mail/openai-api-key`, optional | `openai_model` (`gpt-4.1-nano`) |
| `gemini` | Gemini API (AI Studio) | SSM `/lojo-mail/gemini-api-key` | `gemini_model` (`gemini-2.5-flash-lite`) |
| `vertex` | Vertex AI, service account (preferred) or express-mode key | SSM `/lojo-mail/vertex-sa-json`, else the Gemini key | `gemini_model`, plus `vertex_project`, `vertex_location` |
| `ollama` | Ollama `/api/chat` | none | `ollama_model` |
| `mock` | nothing | none | tests and the demo |

Cheap Bedrock model ids for `bedrock_model_id` (cross-region inference profiles in us-east-1; enable model access in the Bedrock console first): `us.amazon.nova-micro-v1:0`, `us.amazon.nova-lite-v1:0`, `us.amazon.nova-pro-v1:0`, `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `us.meta.llama3-2-1b-instruct-v1:0`, `us.meta.llama3-2-3b-instruct-v1:0`. Nova Micro is the cheapest that returns usable JSON; see [COSTS_COMPARE.md](COSTS_COMPARE.md).

| `embed_provider` | Model variable (default) | Notes |
| --- | --- | --- |
| `none` (Terraform default) | | semantic search is off; nothing is embedded |
| `bedrock` | `bedrock_embed_model_id` (`amazon.titan-embed-text-v2:0`) | recommended in AWS; IAM grants only that model |
| `ollama` | `ollama_embed_model` (`nomic-embed-text`) | the code default and the right choice locally; the Lambda cannot reach the tailnet |
| `openai` | `openai_embed_model` (`text-embedding-3-small`) | |
| `gemini`, `vertex` | `gemini_embed_model` (`gemini-embedding-001`) | |

`embed_dimensions` (256) truncates every vector to that size before storing it, as int8. Changing the embedder or the size changes the vector tag, so old vectors are ignored until `backfill` re-embeds them.

Ollama as the server provider only works where the server can reach labMachine: `npm run dev`, the importer, or a Lambda with a network path to the tailnet (not built here). Terraform warns when `llm_provider` or `embed_provider` is `ollama`.

Only the selected providers' keys are read. Keys come from the environment first (`LOJO_GROK_API_KEY`, `LOJO_OPENAI_API_KEY`, `LOJO_GEMINI_API_KEY`, `LOJO_VERTEX_SA_JSON`), then from SSM. IAM lets each role read only the parameters it needs.

## Semantic search

1. Set `embed_provider` (for example `bedrock`) and apply. The `vectors` index on the messages table is part of the plan either way; DynamoDB adds it online.
2. New inbound mail is embedded at ingest, within the daily token budget. OpenPGP, quarantined mail, and DMARC reports are not embedded. Bulk mail is.
3. Embed older mail: `npm run local -- backfill --limit 50` (or `POST /v1/vectors/backfill`), repeated until `remaining` is 0. In production the API has no envelope private key, so it can embed only mail that still has an AI-context copy: non-bulk inbound mail younger than `ai_context_days` (30). Older mail and old bulk mail show up as `unreadable` and stay out of semantic search. Mail brought over from Tuta can be embedded as it is imported, with `npm run import -- … --embed` (see [MIGRATION.md](MIGRATION.md)).
4. Search: web app → Search → Semantic, `lojo-local search … --semantic`, or `search_mail` with `mode: "semantic"`. All need the `body` scope or a human session.

The query is embedded with the same model and ranked by brute-force cosine over the index (int8 vectors, at most a few MB for years of personal mail). There is no OpenSearch or other always-on service.
