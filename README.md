# lojo-mail

Personal mail for **lojo@cyberphysical.us**. AWS SES receives and sends, S3 and DynamoDB store, a Lambda seals each body to a key only Jon holds, and an AI pipeline summarizes and drafts. A web app, an HTTP API, and an MCP server sit on top. Nothing is sent without Jon approving it in the web app; assistants, Thunderbird (through a local IMAP/SMTP bridge) and mail rules can only queue drafts for approval. The one opt-in exception is an auto-reply rule Jon writes himself, which is off unless he turns it on and is fenced by allowlists, DMARC, loop checks and rate limits. The domain is configuration, so it can move (for example to lojo.dev) without a rewrite.

Nothing in this repo deploys itself. Terraform plans; it does not apply. There are no cloud credentials here and there should never be any.

## Docs

| | |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Shape of the system and why it is Terraform |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, including what is not end-to-end |
| [docs/COSTS.md](docs/COSTS.md) | Monthly estimate (about $2 on Ollama, a few dollars more on Grok) |
| [docs/COSTS_COMPARE.md](docs/COSTS_COMPARE.md) | This design on AWS vs. an equivalent Google Cloud build, and AI provider costs, for low, typical, and heavy use, with sources |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Connecting Cursor, Grok, and local models (Ollama); choosing the AI and embedding provider; semantic search |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Exact steps Jon runs: parameters, apply, first test email, DLQ redrive, rollback |
| [docs/DEPLOY.md](docs/DEPLOY.md) | First-deploy live test: a test message to a test address through SES, the encrypted bucket, and the processor, before real mail is switched on |
| [docs/THUNDERBIRD.md](docs/THUNDERBIRD.md) | Thunderbird as the full mail client through the local IMAP/SMTP bridge: install, account setup, direct send, Drafts, delete |
| [docs/WEB_KEY.md](docs/WEB_KEY.md) | Using the web app from any device: wrapped envelope key, lock and auto-lock, passkey remember, password-manager layout, backup and recovery, rotating the sign-in passphrase |
| [docs/BOTS.md](docs/BOTS.md) | Bots managing your mail: Grok Bot, Grok Build, Cursor, grok.com, local Ollama; bot drafts approved by Send in Thunderbird |
| [config/rules.example.json](config/rules.example.json) | Mail rules: sort, label, archive, trash (restorable), and replies (drafts by default; guarded auto-send). See SECURITY.md, mail rules |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Leaving Tuta (`lojo@tuta.io`) without IMAP, locally or straight into AWS |
| [qa/REVIEW_REPORT.md](qa/REVIEW_REPORT.md) | Independent pre-deploy review, with evidence and screenshots under `qa/` |

## Local demo

```bash
npm ci
npm run dev
```

- Web app: http://127.0.0.1:5173. Sign in with `lojo-dev-passphrase` (printed by the API; set `LOJO_HUMAN_PASSPHRASE` to change it).
- API: http://127.0.0.1:8787. Both bind to `127.0.0.1` only.

The demo mailbox is synthetic and in memory. The LLM is the mock provider unless `LOJO_LLM_PROVIDER` is set. No AWS calls. To browse a mailbox you imported (see MIGRATION.md), start with `LOJO_STORE_FILE=data/mailbox.json npm run dev`.

Node 22 (`.nvmrc`). Checks, as CI runs them:

```bash
npm run lint
npm run typecheck
npm test
npm run secrets:check
npm run build:lambda && npm run bundles:check
npm run build:web
npm run infra:validate   # terraform 1.9+ on PATH: validate, fmt -check, and the mocked `terraform test`
```

For a deployed build of the web app, set `VITE_LOJO_API_URL` to the API Gateway URL when running `npm run build:web`.

## Layout

```text
infra/terraform     SES, KMS, S3, DynamoDB, IAM, Lambda, HTTP API, DNS plan
infra/terraform/tests  Offline `terraform test` with mocked providers
packages/core       MIME, envelope crypto, store, AI pipeline, OpenPGP helpers
packages/pipeline   Inbound processor and the AWS adapters (DynamoDB, S3, KMS)
packages/api        HTTP API
packages/mcp        MCP tools: stdio server and the remote /mcp handler
packages/local      lojo-local CLI and tool-calling adapter for local models
packages/web        PWA
packages/importer   eml / mbox / vCard / CSV import
packages/bridge     Local IMAP + SMTP bridge for Thunderbird (127.0.0.1 only)
packages/core/src/rules  Mail rules engine and auto-send guards
integrations/       Drop-in client config (Cursor mcp.json, systemd unit for the bridge)
fixtures/           Sample, malicious, and DNS fixtures used by the tests
```

Infrastructure defaults: region `us-east-1` (SES for this domain is already there), domain `cyberphysical.us`, local part `lojo`, existing SES identity adopted, DNS changes off, receipt rule set activated because no set is active. See `infra/terraform/terraform.tfvars.example`.
