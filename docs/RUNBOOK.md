# lojo-mail runbook

Jon (or whoever he asks) runs these steps. Nothing in this repo has been applied. A read-only audit of the live account is already folded in below. Re-run the DNS audit before apply in case the zone moved.

Region for this domain: **us-east-1**. SES already has a verified identity there, and the apex MX is already `10 inbound-smtp.us-east-1.amazonaws.com`. `aws_region` stays a variable. Receiving exists only in `us-east-1`, `us-west-2`, and `eu-west-1`.

## Who can apply

IAM user `grok-rw` can use Route 53, Route 53 Domains, and SES. That is not enough to apply this stack. Apply needs permission to create KMS, S3, DynamoDB, Lambda, IAM roles, API Gateway, SQS, CloudWatch Logs and alarms, and SSM parameters, and to read the existing SES identity. Use a principal that has those rights. Do not attach a broader policy to `grok-rw` from this repo, and do not put that user's keys in git.

For the 4f5280c rollout the apply rights were attached to `grok-rw` as two customer managed policies, because one policy hit IAM's 6,144-character limit:

- `GrokLojoMailDeployAndBilling`: [`infra/iam/apply-policy.json`](../infra/iam/apply-policy.json) plus billing actions that are not in this repo.
- `GrokLojoMailWebHosting`: [`infra/iam/apply-policy-web-hosting.json`](../infra/iam/apply-policy-web-hosting.json), the CloudFront and ACM actions for `web_hosting_enabled`.

Keep the two files in step with those policies. `scripts/apply-policy.test.mjs` checks that together they cover every resource type and that each file fits the limit. New CloudFront or ACM actions go in the web hosting file.

`grok-rw` is the right user later for the DNS edits in the plan output (DMARC `rua`, TLS-RPT, MTA-STS) and for Route 53 Domains. It cannot create the DNSSEC signing key.

Other SES identities in the account, `cyberdevsec.com` and the `jon@lojo.engineering` address identity, are out of scope for the main rule. Do not import them and do not point `store-raw` at them. Receiving for `lojo.engineering` is a separate, additive rule: see [Receiving a second domain](#receiving-a-second-domain).

## 0. Tools

- Terraform >= 1.5 (CI uses 1.9.8).
- Node.js 22 (`.nvmrc`). The Lambdas run `nodejs22.x`.
- `jq`, for the redrive commands below.
- AWS CLI authenticated as the apply principal above, not as `grok-rw`.
- A decision about where the envelope private key will live (a password manager is fine).

```bash
cd infra/terraform
terraform init
```

The default backend is local. Before the first real apply, if you want state somewhere safer than a laptop, uncomment the S3 backend in `versions.tf`, create that bucket by hand, and `terraform init -migrate-state`. Do not commit `*.tfstate`.

```bash
cp terraform.tfvars.example terraform.tfvars
terraform plan
```

With the defaults (`ses_identity_mode = existing`, `manage_dns = false`, `manage_active_rule_set = true`, `aws_region = us-east-1`) the plan should:

- Read the existing SES identity. It should not create one, and it should not create DKIM or MAIL FROM attributes.
- Create KMS, S3, six DynamoDB tables, IAM, a configuration set, a receipt rule set, the active association, two Lambdas, an SQS dead-letter queue, an EventBridge rule for the raw/ sweep, two log metric filters, four CloudWatch alarms, and an HTTP API. [DEPLOY.md](DEPLOY.md#required-permissions) lists the exact IAM actions the apply needs.
- Create **no** Route 53 records.

`manage_dns = true` in existing mode fails the plan on purpose.

## 1. Keys and parameters

Generate the envelope keypair on a trusted machine. The private key never goes in AWS.

```bash
npm run keygen -- --out ./keys
```

```bash
aws ssm put-parameter --region us-east-1 \
  --name /lojo-mail/envelope-public-jwk \
  --type String \
  --value file://keys/envelope.public.jwk

aws ssm put-parameter --region us-east-1 \
  --name /lojo-mail/api-token \
  --type SecureString \
  --value "$(openssl rand -hex 32)"

aws ssm put-parameter --region us-east-1 \
  --name /lojo-mail/api-token-send \
  --type SecureString \
  --value "$(openssl rand -hex 32)"

aws ssm put-parameter --region us-east-1 \
  --name /lojo-mail/session-secret \
  --type SecureString \
  --value "$(openssl rand -base64 48)"

aws ssm put-parameter --region us-east-1 \
  --name /lojo-mail/grok-api-key \
  --type SecureString \
  --value 'paste-the-xai-key-here'
```

The web sign-in passphrase is stored as an scrypt hash, never in the clear. Pick a long, random passphrase in the password manager (12 characters minimum; five or more diceware words is better, because sign-in is throttled per source address, not globally; see [SECURITY.md](SECURITY.md#principals)), then:

```bash
npm run passphrase-hash          # prompts without echo; prints the hash
aws ssm put-parameter --region us-east-1 \
  --name /lojo-mail/human-passphrase-hash \
  --type SecureString \
  --value 'scrypt$32768$8$1$…paste the printed hash…'
```

Optional OpenPGP parameters. Leave them unset to send without Jon's own key or a signature:

```bash
aws ssm put-parameter --region us-east-1 --name /lojo-mail/pgp-public-key \
  --type String --value file://keys/lojo.public.asc
# Only if you accept a server-readable signing key (see SECURITY.md, outbound):
aws ssm put-parameter --region us-east-1 --name /lojo-mail/pgp-signing-key \
  --type SecureString --value file://keys/lojo.signing.asc
aws ssm put-parameter --region us-east-1 --name /lojo-mail/pgp-signing-passphrase \
  --type SecureString --value 'signing-key-passphrase'
```

| Parameter | Read by | Required |
| --- | --- | --- |
| `envelope-public-jwk` | processor, API | yes |
| `api-token` | API | yes (the MCP server's token, scopes `read,write`) |
| `api-token-send` | API | no |
| `session-secret` | API | yes, for web sign-in |
| `human-passphrase-hash` | API | yes, for web sign-in |
| `pgp-public-key`, `pgp-signing-key`, `pgp-signing-passphrase` | API | no |
| `grok-api-key` | processor, API | only with `llm_provider = "grok"` |
| `openai-api-key` | processor, API | only with `llm_provider` or `embed_provider` = `"openai"`, and only if that endpoint needs a key |
| `gemini-api-key` | processor, API | only with `"gemini"`, or `"vertex"` in express mode |
| `vertex-sa-json` | processor, API | only with `"vertex"` and a service account (the key file's JSON) |
| `agent-tokens` | API | no; one token per assistant, see [INTEGRATIONS.md](INTEGRATIONS.md#tokens-one-per-client) |
| `bridge-token` | API | no; only for Thunderbird through the local bridge, see [THUNDERBIRD.md](THUNDERBIRD.md). At least 32 characters: `openssl rand -base64 36` |

Store the SecureString values in the password manager. Skip the Grok parameter if you set `llm_provider = "bedrock"` or `"ollama"`. Create a provider key parameter only for the provider you select; [INTEGRATIONS.md](INTEGRATIONS.md#server-side-ai-providers) lists them. The lab Ollama host is on the tailnet. This stack does not connect the Lambda to it.

## 2. Build the Lambdas and apply

```bash
npm ci
npm run build:lambda
cd infra/terraform
terraform plan
terraform apply
```

Before apply, set `processor_bundle = "../../packages/pipeline/dist/processor.mjs"` and `api_bundle = "../../packages/api/dist/api.mjs"` in `terraform.tfvars`. Terraform zips them. The default placeholders throw a clear error. `npm run bundles:check` imports both bundles and fails if either crashes at load.

The first apply runs with `receiving_stage = "test"`. Its receipt rule accepts only `lojo-test@cyberphysical.us`, so real mail is untouched until the live checklist in [DEPLOY.md](DEPLOY.md) passes. Then `receiving_stage = "live"` switches the rule to `lojo@cyberphysical.us` and `dmarc@cyberphysical.us` only. Other local parts at the domain never have a rule, so SES does not store them. That is deliberate.

Before apply, confirm again that no receipt rule set is active in us-east-1 (`aws ses describe-active-receipt-rule-set --region us-east-1`). The audit found none. If one appeared, set `manage_active_rule_set = false` and add a rule to the existing set instead. Activating this set replaces the only active set in the region.

## 3. Do not redo SES DNS

The identity is already verified. Easy DKIM CNAMEs are already published. MAIL FROM `mail.cyberphysical.us` is already the feedback MX plus an SPF TXT. Do not create three more DKIM CNAMEs from `terraform output dkim_tokens`. Those tokens describe the keys already in DNS.

Confirm in the SES console, region us-east-1:

- Identity `cyberphysical.us` verified.
- DKIM successful.
- Custom MAIL FROM successful.

Then stop. No Route 53 change in this step.

## 4. Production access and warm-up

Receiving does not require production access. Sending to arbitrary recipients does. The audit did not show whether the account is still in the sandbox.

If it is, request production access in us-east-1 (transactional, personal mailbox, no dedicated IP, no purchased list). While you wait, send tests to a verified identity. Check `dkim=pass` on a received copy.

Leave the live DMARC policy at `p=quarantine`. It is already there. Do not drop it to `p=none` to "start over." Warm up outbound the same way as any new stream: a handful of real messages a day, no list, no Virtual Deliverability Manager. Move toward `p=reject` only after reports show nothing legitimate is failing. Do not set `aspf=s`. Strict SPF alignment fails for a custom MAIL FROM at `mail.cyberphysical.us`.

If the account was created in a new region after 21 July 2026 it may be on the SES Essentials plan. Switch to à la carte. Do not pick Pro. See [COSTS.md](COSTS.md).

## 5. DNS that already exists, and additions that stay a plan

Already in the zone. Do not touch:

- NS and SOA
- The ACM validation CNAME
- The six Easy DKIM CNAMEs
- `_amazonses` TXT
- `mail.cyberphysical.us` MX `10 feedback-smtp.us-east-1.amazonses.com` and its SPF TXT
- Apex SPF `v=spf1 include:amazonses.com ~all` (one TXT; do not add another; do not change `~all` to `-all` as part of this work)
- Apex MX `10 inbound-smtp.us-east-1.amazonaws.com`

Optional cleanup, only after you confirm WorkMail is gone:

- `autodiscover` CNAME
- `_amazonchime` TXT

Suggested additions. `terraform output dns_plan` prints them. Terraform does not create them. `grok-rw` can make these edits later:

- Edit the existing `_dmarc` TXT in place to `v=DMARC1; p=quarantine; pct=100; fo=1; rua=mailto:dmarc@cyberphysical.us`. One record. The receipt rule already accepts `dmarc@` so the reports have somewhere to land.
- Add `_smtp._tls` TXT `v=TLSRPTv1; rua=mailto:dmarc@cyberphysical.us`.
- (Done by `web_hosting_enabled`, see section 9.) Serve `docs/mta-sts.txt` at `https://mta-sts.cyberphysical.us/.well-known/mta-sts.txt`, then add the `_mta-sts` TXT. The file is `mode: testing` and names the us-east-1 inbound MX. The TXT alone does nothing.
- Host the OpenPGP public key at the WKD advanced URL (`npm run wkd-hash`). No DNS record until that HTTPS host exists. Publish only the public key.
- Apex MX TTL is 1800 and the target is already correct. Lower it to 300 only before a future move off us-east-1.

Optional, after mail works: turn on DNSSEC. The registrar is Gandi via Route 53 Domains, and DNSSEC is off. Enabling means a KMS key for the hosted zone, `aws route53 enable-hosted-zone-dnssec`, and a DS record at the registrar. `grok-rw` does not have KMS, so the signing key is a separate step. Do not combine it with the receipt apply.

## 6. Checklist before apply

```bash
aws route53 list-hosted-zones-by-name --dns-name cyberphysical.us \
  --query 'HostedZones[0].Id' --output text

aws route53 list-resource-record-sets --hosted-zone-id ZONE_ID \
  --output json > /tmp/cyberphysical.zone.json

node scripts/dns-audit.mjs /tmp/cyberphysical.zone.json cyberphysical.us us-east-1

aws ses describe-active-receipt-rule-set --region us-east-1
```

The audit script is read-only. On a zone that still matches the September 2026 picture it exits 0. An apex MX that is not SES us-east-1 is a blocker.

- [ ] SOA and NS left untouched.
- [ ] ACM validation CNAME left untouched.
- [ ] Six DKIM CNAMEs still present. No plan to add more.
- [ ] `_amazonses` left untouched.
- [ ] `mail.` MX and TXT left untouched.
- [ ] Apex SPF is the single `include:amazonses.com` TXT. No second SPF.
- [ ] Apex MX is `10 inbound-smtp.us-east-1.amazonaws.com`. Target will not change. TTL 1800 is fine for this apply.
- [ ] DMARC is still the one `p=quarantine` TXT. `rua` is a later edit, not part of apply.
- [ ] `autodiscover` and `_amazonchime` noted. Not deleted unless WorkMail is confirmed gone.
- [ ] Website and other non-mail records left untouched.
- [ ] No active receipt rule set in us-east-1, or you have decided not to activate this one.
- [ ] `terraform plan` creates no Route 53 changes.
- [ ] `ses_identity_mode` is `existing` and `manage_dns` is false.

Then `terraform apply`.

### First test email

Follow [DEPLOY.md](DEPLOY.md) for the first deploy. It sends a test message to `lojo-test@` and checks every hop before real mail is switched on. The commands below are the short version, useful again later.

SES writes an `AMAZON_SES_SETUP_NOTIFICATION` object when the rule is created. The processor skips it; that is expected. Then send a short message from an outside account to the address the rule accepts (`terraform output receiving`) and check each hop:

```bash
cd infra/terraform
BUCKET=$(terraform output -raw bucket)
TABLE=$(terraform output -json tables | jq -r .messages)

aws logs tail /aws/lambda/lojo-mail-processor --since 10m --region us-east-1
aws dynamodb query --region us-east-1 --table-name "$TABLE" --index-name folder \
  --key-condition-expression 'folder = :f' --expression-attribute-values '{":f":{"S":"inbox"}}' \
  --no-scan-index-forward --max-items 1 \
  --query 'Items[0].{subject:subject.S,bodyKey:bodyKey.S,verdicts:verdicts}'
aws s3 ls "s3://$BUCKET/raw/"      # empty again: raw is deleted after ingest
aws s3 ls "s3://$BUCKET/objects/"  # the sealed body
```

The item has a `bodyKey` and no body text. Its `verdicts` should show SPF, DKIM, and DMARC `PASS` for a normal sender. Then sign in to the PWA, load the envelope key in Settings, and open the message.

`dig MX cyberphysical.us` should keep answering:

```text
10 inbound-smtp.us-east-1.amazonaws.com.
```

## 7. Failed messages and redrive

If the processor throws (for example a KMS or DynamoDB error), S3's async invoke retries twice, then puts the event in the DLQ. Alarm `lojo-mail-processor-dlq-not-empty` fires, and the raw MIME stays under `raw/` until `raw_retention_days` (7). Fix the cause, then redrive. Each message body is the original S3 event, so it can be replayed as-is; ingest is idempotent per `raw/` key. The raw/ sweep also retries anything still under `raw/` every 15 minutes. After you fix the cause, the sweep drains `raw/` on its own. The DLQ still holds the events, so redrive them or purge the queue to clear the alarm. A sweep that keeps failing on the same object keeps the processor-errors alarm firing until it is fixed or the object expires.

```bash
cd infra/terraform
QUEUE=$(terraform output -raw processor_dlq_url)
while MSG=$(aws sqs receive-message --region us-east-1 --queue-url "$QUEUE" \
      --max-number-of-messages 1 --wait-time-seconds 2 --output json) \
    && [ -n "$(echo "$MSG" | jq -r '.Messages[0].Body // empty')" ]; do
  echo "$MSG" | jq -r '.Messages[0].Body' > /tmp/lojo-event.json
  OUT=$(aws lambda invoke --region us-east-1 --function-name lojo-mail-processor \
    --cli-binary-format raw-in-base64-out --payload file:///tmp/lojo-event.json /tmp/lojo-result.json)
  if echo "$OUT" | jq -e '.FunctionError' > /dev/null; then cat /tmp/lojo-result.json; break; fi
  aws sqs delete-message --region us-east-1 --queue-url "$QUEUE" \
    --receipt-handle "$(echo "$MSG" | jq -r '.Messages[0].ReceiptHandle')"
done
```

The loop stops at the first failure and leaves that message in the queue. A message whose `raw/` object has already expired cannot be recovered from AWS; ask the sender to resend.

## 8. Revert

The MX was already SES. Do not point it somewhere else to undo a bad apply.

1. Set `manage_active_rule_set` to false and apply, or delete the active rule set association. That returns the region to "no active receipt rule set," which is the previous state. It also stops any other SES receiving in us-east-1, so do it only if this set is the one you just activated.
2. Leave DKIM, SPF, MAIL FROM, DMARC, and the MX target as they were.

Rolling back code, not receiving: check out the previous commit, `npm run build:lambda`, and apply again. Only the function code changes. Mail that arrives meanwhile waits in `raw/` or the DLQ. The tables have deletion protection, so a `terraform destroy` stops at them; turn `deletion_protection_enabled` off by hand only if you really mean to delete the index. The bucket is `force_destroy = false`.

## 9. The web app

Build it against the API and host it on an HTTPS origin you already have:

```bash
VITE_LOJO_API_URL=$(terraform -chdir=infra/terraform output -raw api_endpoint) \
VITE_LOJO_BLOB_ORIGIN=$(terraform -chdir=infra/terraform output -raw web_blob_origin) \
  npm run build:web
# upload packages/web/dist/ to the HTTPS origin
```

Add that origin to `web_origins` in `terraform.tfvars` and apply. That list drives the API's CORS and the bucket's CORS for presigned attachment downloads.

The build's Content-Security-Policy allows connections only to the page's own origin, the API origin, and the one mail-bucket origin that presigned attachment URLs use. There is no S3 wildcard. The build fails if `VITE_LOJO_API_URL` is set without `VITE_LOJO_BLOB_ORIGIN`, or if either one is a wildcard or not https. Rebuild if the API URL or bucket changes. Settings has an API URL override for local testing, but the policy still limits connections to the built-in origins.

The policy is in a `<meta>` tag, and browsers ignore `frame-ancestors` there. The host must send the headers in `dist/_headers`:

- `Content-Security-Policy` with the full policy, including `frame-ancestors 'none'`;
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

Netlify and Cloudflare Pages read `_headers` as it is. On CloudFront, copy the same values into a response headers policy. After deploy, check with `curl -sI https://<web origin>/ | grep -i -E 'content-security|x-frame'`. As a backstop, the app refuses to start inside a frame.

### Hosting it on CloudFront (optional Terraform, `web_hosting_enabled`)

`infra/terraform/web_hosting.tf` builds the cheap version of "an HTTPS origin you already have". It is off by default. Turn it on in `terraform.tfvars`:

```hcl
zone_id             = "Z00717522DVA6Y0FKVFVM"
web_hosting_enabled = true
web_origins         = ["http://127.0.0.1:5173", "http://localhost:5173", "https://app.cyberphysical.us"]
```

Order matters, because the response headers policy is read from `packages/web/dist/_headers`:

1. `VITE_LOJO_API_URL=<api_endpoint> VITE_LOJO_BLOB_ORIGIN=<web_blob_origin> npm run build:web`
2. `terraform apply` (creates the resources below)
3. `scripts/deploy-web.sh` (rebuilds, uploads `dist/` to `s3://<web bucket>/app/`, invalidates the shell files)

What it creates, all in us-east-1: a private S3 bucket (public access blocked, SSE-S3, TLS-only, reads only by the two distributions through origin access control); one ACM certificate for `app.` and `mta-sts.` (DNS validation); two CloudFront distributions (PriceClass_100, TLS 1.2+, HTTP/2 and 3, IPv6), one per host, so the app host never serves the policy and the policy host never serves the app; a response headers policy with the `_headers` values (CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`) plus HSTS; and Route 53 records. Terraform sets `allow_overwrite = false` on every record it writes, so it cannot edit an existing one.

Records it writes: `app.` and `mta-sts.` alias A and AAAA to CloudFront, the two ACM validation CNAMEs, `_smtp._tls` TXT (`web_hosting_publish_tls_rpt`), and `_mta-sts` TXT only when `web_hosting_publish_mta_sts_txt = true`. Set that flag after `curl https://mta-sts.<domain>/.well-known/mta-sts.txt` returns the policy. Bump `mta_sts_id` whenever `docs/mta-sts.txt` changes. The `_dmarc` TXT is not Terraform's: it already exists, so it was edited in place by hand (`rua=mailto:dmarc@cyberphysical.us`).

Cost: no per-distribution or per-certificate charge. The bucket is under 1 MB. At personal traffic (a few thousand requests a month) CloudFront stays inside its always-free tier (1 TB out, 10M requests), Route 53 lookups for the alias records are free, and the S3 bill is a fraction of a cent. The only fixed cost is what the hosted zone already costs. Expect about $0.00 to $0.05 a month.

Browsers send an `OPTIONS` preflight to the API. API Gateway hands it to the `$default` Lambda route, so the app answers `OPTIONS` with 204 and the gateway's CORS configuration adds the `access-control-*` headers.

## 10. Day-two

- On Santa, run `lojo-bridge key export-wrapped` and store the wrapped key and key passphrase as in [WEB_KEY.md](WEB_KEY.md#3-password-manager-layout). Then open the PWA over HTTPS, sign in with the passphrase, unlock with the wrapped key in Settings, check that the fingerprint matches, and confirm a real message opens.
- Rotating the web sign-in passphrase and the recovery drill for the envelope key are in [WEB_KEY.md](WEB_KEY.md).
- Drafts that an assistant submitted appear under Drafts → "Waiting for your approval". Open one, check it, including the Encryption setting, and press Approve and send. If the assistant edits it while you have it open, nothing is sent: the page shows the new version and you approve again.
- Put a budget alarm on the `Project=lojo-mail` tag. See [COSTS.md](COSTS.md).
- Follow [MIGRATION.md](MIGRATION.md) for Tuta.
- Add the DMARC `rua` when you want reports. Reports arrive at `dmarc@cyberphysical.us`, skip the model, and are archived with the label `dmarc-report`.
- Rotate a token, the passphrase hash, or the session secret by writing a new SSM value (`--overwrite`). The API caches its configuration for `LOJO_CONFIG_TTL_MS` (5 minutes by default), so the old value keeps working for up to that long in a warm container. Rotating the session secret signs everyone out.
- Point `alarm_actions` at an SNS topic if you want the DLQ, error, raw/ swept, and sign-in failure alarms to page you. The raw/ swept alarm means the S3 notification missed mail and the sweep delivered it; see [DEPLOY.md](DEPLOY.md#if-mail-sits-in-raw). `login_failure_alarm_threshold` (default 20 per hour) sets when failed sign-ins across all sources trip the alarm. If it fires and it was not you, rotate the passphrase hash and the session secret.
- To switch the domain later, set `domain` and `ses_identity_mode = create`, then repeat identity, DKIM, and DNS for that new name. Do not delete the `cyberphysical.us` identity until mail to it can die. `manage_dns` is allowed only in create mode, and only with the confirmation string, after an audit of the new zone.

### Mail rules

- Start from `config/rules.example.json`. Check a file with `npm run rules -- validate my-rules.json`; it lists every rule that trashes or auto-sends. Push it with `npm run rules -- push my-rules.json --api "$API"`: it asks you to type `yes`, then for your passphrase, and saves with a human session. Tokens cannot save rules.
- Try a rule against a stored message before relying on it: `curl -s "$API/v1/rules/test" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"messageId":"msg_…"}'`. It lists the matching rules and every reason an auto-send would be refused.
- Stop everything at once: `curl -s "$API/v1/rules/switches" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"paused":true}'`. `{"killSwitch":true}` stops only auto-send. `{"sendKillSwitch":true}` stops **all** sending: Thunderbird sends, approved drafts, and auto-send. Any `write` token can do this; only your session can undo it (web app → Rules, or `npm run rules -- push` with `"paused": false`, `"sendKillSwitch": false`).
- Bridge token stolen or Santa lost: engage `sendKillSwitch` first (it stops the bridge from sending at once), then rotate `/lojo-mail/bridge-token` and wait for the 5-minute reload. Review `send.client` rows in the audit log for what went out.
- A bot misbehaving: remove its entry from `/lojo-mail/agent-tokens` (5-minute reload). Its trashes are restorable from Trash (the web app shows "Trashed by agent <label>") until the retention window ends.
- Trashed by a rule by mistake: `POST /v1/messages/:id/restore`. Rule actions are in the audit log (`GET /v1/audit?limit=500`, actions `rule.apply`, `rule.trash`, `rule.reply`, `rule.shadow`, `rule.autosend`, `rule.unsubscribe`).
- Trashed mail keeps a `keepUntil` date and is only removed by the trash purge below.
- `GET /v1/rules` answering 503 `unavailable` ("S3 denied rules/current.bin") means a role is missing `s3:GetObject` on `rules/*` or `s3:ListBucket` on the `rules/` prefix (statements `ReadRules`/`RulesObject` and `ListRulesPrefix` in `iam.tf`). Without ListBucket, S3 reports a missing object as `AccessDenied`, so a mailbox with no rules saved looked broken (the 500 in the 4f5280c rollout). The API refuses to treat that as "no rules", because pause and disable write back what they read and would replace the real rules. The processor delivers without rules and audits `rules.load` / `error`. Fix the role; do not work around it.
- Auto-send stays off until `auto_send_enabled = true` in `terraform.tfvars` and an apply; the plan shows only the processor's SES statement and `LOJO_AUTO_SEND` changing. Without it, auto-send rules write drafts for approval, and live unsubscribe rules audit `refused` (the same flag enables the one-click POST, which is outbound HTTPS from the processor).
- Rules that send go **shadow first**: save the reply as `"mode": "shadow"` (or the unsubscribe as `"mode": "shadow"`), watch `rule.shadow` / `rule.unsubscribe` in the audit log (or the bot digest's `automation` section), then take it live in the web app (Settings → Mail rules → Go live) or with `lojo-bot admin rule-mode <id> live`. A push that goes straight to `autoSend`/`auto` is refused.
- Bot proposals arrive disabled (`createdBy: bot`, chip "bot proposal"). Enable one in the web app or with `lojo-bot admin rule-enable <id>`; enabling makes it your rule.
- Unsubscribes: `rule.unsubscribe` outcomes are `done` (message labelled `unsubscribed`), `failed` (HTTP status or SES error), `refused` and the two shadow outcomes. A list is unsubscribed at most once per 30 days.

### Trash purge

Trash is emptied only by the `lojo-mail-trash-purge` Lambda (daily). It starts in report mode: it deletes nothing and audits what it would delete.

- Read the reports: `curl -s "$API/v1/audit" -H "Authorization: Bearer $TOKEN"` and look for `trash.purge_report` (report mode: how many messages are in Trash, past their window, and unmarked). In purge mode each run writes `trash.purge_run` (counts, and `backlog` when more than 100 were due) and one `trash.purged` per message. To see which messages are due before switching, open Trash in the web app: each row shows its `keepUntil` date. Messages in Trash without a `keepUntil` or `trashedAt` are never purged; restore them or re-trash them from the web app to give them a window.
- Keep something longer: restore it (`POST /v1/messages/:id/restore`, or the web app). Raising `trashRetentionDays` applies only to mail trashed afterwards.
- Switch to deleting: set `trash_purge_mode = "purge"` in `terraform.tfvars`, `terraform plan` (only the purge role's `PurgeExpiredTrash` and `DeletePurgedObjects` statements and `LOJO_TRASH_PURGE` change), then apply. Back to `report` removes the delete permissions again; `off` disables the schedule.
- Run it once by hand: `aws lambda invoke --function-name lojo-mail-trash-purge --payload '{}' /dev/stdout`. The log line `trash_purge` gives the counts.
- The errors alarm means a run failed. Nothing is lost: expired trash stays until a run succeeds. Look for `trash.purge_skipped` (a message changed during the run, usually a restore) and `trash.purge_blob_failed` (the row is gone but an object was left; it is sealed and unreadable without your key, and you can delete it by the key in the audit detail).
- Undo a purge within the backup windows: objects come back from their S3 noncurrent version (30 days: `aws s3api list-object-versions --bucket <bucket> --prefix objects/<id>`, then copy the version back), and the message row from DynamoDB point-in-time recovery (35 days: restore the messages table to a new table from before the run, and copy the item back). After those windows the message is gone.

## 11. Local demo, no AWS

```bash
npm ci
npm run dev
```

API on `http://127.0.0.1:8787`, web app on `http://127.0.0.1:5173`, in-memory mailbox with synthetic messages, mock LLM unless you set `LOJO_LLM_PROVIDER`. Both bind to `127.0.0.1`. The API log prints the web sign-in passphrase (`lojo-dev-passphrase` unless `LOJO_HUMAN_PASSPHRASE` is set) and the local API tokens. The dev passphrase and tokens are refused if `NODE_ENV=production`.

To browse an imported mailbox instead, start the API with `LOJO_STORE_FILE=data/mailbox.json`. That store is locked: load `data/mailbox.json.private.jwk` in Settings to read bodies.

## Receiving a second domain

`extra_receiving_domains = ["lojo.engineering"]` and `extra_receiving_addresses = ["jon@lojo.engineering"]` (live stage) add, without touching `store-raw`:

- an SES **domain** identity with Easy DKIM (3 CNAME tokens in `terraform output extra_domain_dkim_tokens`; no MAIL FROM, no DNS written);
- a second receipt rule `store-raw-lojo-engineering` on the same rule set, same bucket/`raw/` prefix, TLS `Require`, spam/virus scan, recipient exactly `jon@lojo.engineering`.

The processor does not filter by recipient, so mail to that address lands in the same mailbox. Mail starts flowing only when the domain's MX points at `10 inbound-smtp.us-east-1.amazonaws.com`. Existing DKIM (for example Tuta's `s1`/`s2._domainkey`) and SPF stay until sending through the old provider is retired.

Rollback: remove the two variables and apply (destroys the rule and the domain identity), or `aws ses delete-receipt-rule --rule-set-name lojo-mail --rule-name store-raw-lojo-engineering` and `aws sesv2 delete-email-identity --email-identity lojo.engineering`. Point the MX back first if it was switched.
