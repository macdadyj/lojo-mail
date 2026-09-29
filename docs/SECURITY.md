# lojo-mail security

This document is the contract the code is reviewed against. If behavior and this file disagree, fix one of them before trusting the system with real mail.

## Threat model

### Assets

- Message bodies, attachments, and the sensitive half of AI output (summaries, action items, draft replies).
- The mailbox index (subjects, addresses, labels, snippets).
- Jon's OpenPGP private key and the envelope private key.
- The API tokens, especially any token with the `send` scope.
- The ability to send as `lojo@cyberphysical.us` (reputation and impersonation).

### Trust boundary

Jon's machines (browser session, the machine that holds the private key, the Ollama host on his tailnet) are inside the boundary. AWS SES, the processor Lambda, the LLM provider, and anyone who can assume the Lambda roles are on the boundary or outside it, depending on the layer.

### What an attacker gets

| Attacker | What they can read |
| --- | --- |
| Passive network observer | Nothing useful if both sides negotiate TLS. Senders that cannot do TLS are rejected by the receipt rule, so their mail never arrives. |
| SES, or anyone who compromises the receipt path before the object is sealed | Full plaintext of mail that was not OpenPGP-encrypted by the sender. This includes AWS operators with production access to SES, and a malicious or buggy receipt integration. |
| S3 reader without KMS | Ciphertext only (SSE-KMS). |
| S3 + KMS reader, or DynamoDB + KMS reader, without Jon's private key | Raw MIME if it has not been lifecycle-expired, **and** the index (subjects, addresses, snippets, categories, phishing scores, attachment names). Not the sealed body, not the sealed AI summary. |
| Processor Lambda role (or anyone who can change its code) | Plaintext at processing time, and the ability to skip sealing or to copy the body out. This is the most important application trust assumption. |
| LLM provider | The truncated plaintext of messages that were actually submitted, plus the style guide. Bulk mail is not submitted. Over-budget mail is not submitted. |
| Ollama on the tailnet | Same as the LLM provider, but the host is Jon's. The network path is the tailnet, not the public internet. |
| Stolen API token, `read` only | Index, and bodies only if the caller also has the private key (the API does not store it). |
| Stolen API token, `send` | Can approve and send mail as Jon, within SES limits. |
| Stolen envelope private key | Can open every sealed body, forever. There is no forward secrecy against a later key compromise: each message uses a fresh ephemeral key, but the recipient key is long-term. |

## What is not end-to-end

**Ordinary mail is not end-to-end encrypted.** SES terminates SMTP. The message exists as plaintext inside SES, then as a KMS-encrypted object, then as plaintext inside the processor Lambda, and only then as an envelope ciphertext. AWS can read mail during receipt. A compromised Lambda can read mail during processing and can read whatever is sent to the LLM.

Say this plainly to anyone who compares the system to Tuta: Tuta's promise is that the provider cannot read the mailbox. lojo-mail's promise is different. The provider can read mail on the way in. After processing, a thief who steals the bucket and the DynamoDB table but not Jon's private key cannot read bodies. That is defense in depth, not end-to-end encryption.

**End-to-end is the OpenPGP path.** If a sender encrypts to Jon's published key, SES and the processor see armor, not contents. The processor stores the armor inside the envelope and does not ask the LLM to summarize ciphertext. If Jon sends through `approve_and_send` and a recipient public key is on file, the API encrypts (and, when he has unlocked a signing key, signs) before SESv2 sees the body. SES still sees headers.

## Controls

### Transport

- Inbound `tls_policy = Require` on the receipt rule. Tradeoff: a sender that does not offer STARTTLS cannot deliver. That is the point of "TLS enforced both ways." If a specific correspondent is stuck on a legacy server, the switch is in Terraform and should be temporary.
- Outbound SESv2 configuration set `tls_policy = REQUIRE`.
- DNS plan includes MTA-STS (`mode: testing` until the MX is stable, then `enforce`) and a TLS-RPT report address. MTA-STS only helps once `https://mta-sts.<domain>/.well-known/mta-sts.txt` is actually served. The policy file is in `docs/mta-sts.txt`. Publishing the TXT record without the HTTPS policy does nothing useful; the runbook orders the steps.
- S3 bucket policy denies any request where `aws:SecureTransport` is false.
- API is HTTPS at API Gateway. The PWA must be served over HTTPS in production because the browser holds the private key.

### At rest

- One customer-managed KMS key, rotation enabled, alias `alias/lojo-mail`.
- Bucket: Block Public Access on, BucketOwnerEnforced, versioning on, default encryption SSE-KMS with bucket keys.
- DynamoDB: SSE-KMS with the same key, point-in-time recovery on.
- Raw MIME retention is a variable (`raw_retention_days`, default 365). Raw MIME is plaintext-under-KMS, so it is a second copy of the secret. Shorten the retention if that copy bothers you more than the ability to reprocess.

### Envelope

Algorithm `lojo-env-v1`:

1. Generate an ephemeral P-256 key.
2. ECDH with Jon's long-term P-256 public key.
3. HKDF-SHA256 (empty salt, info `lojo-mail-envelope-v1`) to an AES-256-GCM key.
4. Encrypt the JSON payload (`text`, `html`, attachment bytes, sensitive AI fields) with a random 12-byte IV.
5. Store the ephemeral public JWK, IV, and ciphertext.

The public key is published to SSM as a name the Lambda reads (`/lojo-mail/envelope-public-jwk`). The private JWK stays with Jon (password manager or a hardware-backed file). The API process may hold the private key in memory after `POST /v1/session/unlock` for local dev. The deployed Lambda API does not persist it and does not need it: the web app opens envelopes locally. Do not "make it easier" by putting the private key in SSM.

### IAM

- Processor role: `s3:GetObject` on `raw/*`, `s3:PutObject` on `objects/*`, KMS encrypt/decrypt on this key only, DynamoDB read/write on these tables only, `ssm:GetParameter` on `/lojo-mail/*`, logs. No SES send.
- API role: DynamoDB, `s3:GetObject` on `objects/*`, KMS decrypt, `ses:SendEmail` and `ses:SendRawEmail` constrained by `ses:FromAddress`, SSM read, logs. No `s3:PutObject` on `raw/*`.
- No `*` resource on data APIs. No IAM write. No SES identity administration from the runtime roles.
- Receipt rule set activation is a Terraform flag defaulting off, because a region has one active rule set and flipping it affects every identity in the account.

### AI

- Provider keys come from the environment or SSM. They are not in the repo and not in Terraform state. Terraform never sets a secret value.
- Daily token budget, truncation (`max_body_chars`), and bulk skip.
- Audit row per attempt: time, message id, provider, model, action, token counts, outcome, SHA-256 of the prompt. Not the prompt, not the body.
- Suggested replies are drafts. Sending requires `send` scope on `POST /v1/drafts/:id/approve-and-send`.
- Phishing score is advisory. The app shows it; it does not auto-delete mail.

### Application auth

- Bearer tokens with scopes. MCP tools check the same scopes.
- Production boot refuses the well-known dev token values.
- CORS origins are an explicit list.

### OpenPGP / WKD

- Publish only the public key.
- WKD advanced path: `https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<z-base32(sha1(local-part))>`.
- Direct path, if the apex site is HTTPS: `https://<domain>/.well-known/openpgpkey/hu/<hash>`.
- Inbound PGP/MIME or armored ciphertext is flagged `pgpEncrypted` and is not sent to the LLM.
- The repo ships no private key and no real public key. `keys/README.md` is the procedure. Tests generate ephemeral keys.

### Repo and CI

- `.gitignore` blocks `.env`, private keys, tfstate, and import dumps.
- `scripts/check-no-secrets.mjs` fails CI on `AKIA`, PEM private keys, armored PGP private keys, and Terraform secret-looking assignments.
- GitHub Actions runs tests, typecheck, lint, the secret scan, and `terraform validate`. It does not run `terraform apply` and it has no AWS keys.

## Residual risks

- A subject line is often the whole secret ("your test results", "offer letter"). The index stores subjects. Accept that or accept a worse inbox.
- Snippets are stored in the clear by default (`snippetInClear`). Set it false to keep snippets out of DynamoDB; the inbox list will show subjects only.
- Embeddings are stored in the clear when semantic search is on. They are not the text, but they leak similarity. Disable embeddings if that matters more than search.
- The processor sees plaintext. Review changes to `packages/pipeline` as if they were changes to an MTA.
- SES sandbox and production access are account-level. Production access is what allows sending to arbitrary recipients. Guard the `send` token accordingly.
- DKIM and SPF protect recipients from forgery of the domain. They do not encrypt anything.
- MTA-STS in `testing` mode does not fail closed. Move to `enforce` only after the policy host is up and you have read a few TLS-RPT reports.
- Reprocessing raw MIME re-exposes plaintext to the processor. That is why raw retention is bounded.
- Client-side unlock keeps the private key in `sessionStorage` only if Jon opts in. The default is in-memory, which dies with the tab. `sessionStorage` survives refresh and is readable by any script on the origin. Do not add third-party scripts to the PWA.

## Out of scope

- Multi-user mailboxes, key escrow, and account recovery. If the private key is lost, sealed bodies are lost. Raw MIME remains until retention deletes it, and reprocessing can reseal to a new public key while raw objects still exist. After retention, loss of the key is loss of the bodies.
- Anonymous inbound. The address will get spam. Spam/virus scanning is the SES receipt scan plus the phishing scorer, not a promise of a clean inbox.
