# lojo-mail

Personal mail for **lojo@cyberphysical.us**. AWS SES receives and sends, S3 and DynamoDB store, a Lambda seals each body to a key only Jon holds, and an AI pipeline summarizes and drafts. A web app, an HTTP API, and an MCP server sit on top. The domain is configuration, so it can move (for example to lojo.dev) without a rewrite.

Nothing in this repo deploys itself. Terraform plans; it does not apply. There are no cloud credentials here and there should never be any.

## Docs

| | |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Shape of the system and why it is Terraform |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, including what is not end-to-end |
| [docs/COSTS.md](docs/COSTS.md) | Monthly estimate (about $2 on Ollama, a few dollars more on Grok) |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Exact steps Jon runs, including the MX dry-run |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Leaving Tuta (`lojo@tuta.io`) without IMAP |

## Local demo

```bash
npm ci
npm run dev
```

- Web app: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

The demo mailbox is synthetic and in memory. The LLM is the mock provider unless `LOJO_LLM_PROVIDER` is set. No AWS calls.

```bash
npm test
npm run typecheck
npm run lint
npm run infra:validate
```

## Layout

```text
infra/terraform     SES, KMS, S3, DynamoDB, IAM, Lambda, HTTP API, DNS plan
packages/core       MIME, envelope crypto, store, AI pipeline, OpenPGP helpers
packages/pipeline   Inbound processor
packages/api        HTTP API
packages/mcp        MCP tools
packages/web        PWA
packages/importer   eml / mbox / vCard / CSV import
```

Infrastructure defaults: region `us-west-2`, domain `cyberphysical.us`, local part `lojo`, DNS changes off, receipt rule set not activated. See `infra/terraform/terraform.tfvars.example`.
