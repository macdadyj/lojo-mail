# lojo-mail runbook

Jon (or whoever he asks) runs these steps. The agent that wrote this repo did not have AWS credentials and did not run them. Do not skip the DNS audit. The `cyberphysical.us` zone already has 17 records and this project does not know what they are.

Region for everything in this stack: **us-west-2**. SES email receiving exists only in `us-east-1`, `us-west-2`, and `eu-west-1`. The Terraform variable rejects other regions.

## 0. Tools

- Terraform >= 1.5 (CI uses 1.9.8).
- Node.js 20 or newer.
- AWS CLI authenticated as a principal that can create the resources in `infra/terraform` and read Route 53. Administrator is enough for a personal account; a tighter IAM user is better if you already have one.
- A KMS-backed decision about where the envelope private key will live (password manager is fine).

```bash
cd infra/terraform
terraform init
```

The default backend is local. Before the first real apply, if you want state somewhere safer than a laptop, uncomment the S3 backend in `versions.tf`, create that bucket by hand (or a one-off bootstrap), and `terraform init -migrate-state`. Do not commit `*.tfstate`. It can contain resource IDs and, if you ever put a secret in a variable, the secret.

```bash
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — it is gitignored
terraform plan
```

Read the plan. It should want to create KMS, S3, DynamoDB, IAM, SES identity, a receipt rule set that is **not** active, two Lambdas, and an HTTP API. It should **not** want to change Route 53 while `manage_dns` is false.

## 1. Keys and parameters (before apply is also fine)

Generate the envelope keypair on a trusted machine. The private key never goes in AWS.

```bash
npm run keygen -- --out ./keys
# writes keys/envelope.public.jwk and keys/envelope.private.jwk
# keys/ is gitignored except keys/README.md
```

Put the public key where the processor can read it, and create the API token and (only if you will use Grok) the API key. These commands write secrets to SSM. They are the point; do not copy the values into Terraform.

```bash
aws ssm put-parameter --region us-west-2 \
  --name /lojo-mail/envelope-public-jwk \
  --type String \
  --value file://keys/envelope.public.jwk

aws ssm put-parameter --region us-west-2 \
  --name /lojo-mail/api-token \
  --type SecureString \
  --value "$(openssl rand -hex 32)"

# Optional second token that is allowed to send. The first token can be read+write only.
aws ssm put-parameter --region us-west-2 \
  --name /lojo-mail/api-token-send \
  --type SecureString \
  --value "$(openssl rand -hex 32)"

aws ssm put-parameter --region us-west-2 \
  --name /lojo-mail/grok-api-key \
  --type SecureString \
  --value 'paste-the-xai-key-here'
```

Store the SecureString values in the password manager at the same time. SSM is not a convenient place to recover a token you did not save. Standard SecureString parameters do not show the value again in `put-parameter` output; retrieve it once with `aws ssm get-parameter --with-decryption` and save it.

If you are starting on Ollama instead, skip the Grok parameter and set `llm_provider = "ollama"` in `terraform.tfvars`. The lab host `http://100.96.1.90:11434` is on the tailnet. A Lambda in AWS cannot reach a tailnet address unless you specifically connect the VPC to Tailscale, which this stack does not do (that would be a NAT gateway and a subnet, and it would cost more than the rest of the system). Practical split:

- **Receipt and storage** run in AWS.
- **AI** either calls Grok or Bedrock from the Lambda, or you run the processor locally / on the lab machine against the bucket. For the first weeks, `llm_provider = "bedrock"` or `"grok"` is the one that works inside Lambda. Use Ollama for the local app (`npm run dev`) and for backfill.

## 2. Build the Lambdas and apply

```bash
npm ci
npm run build:lambda
cd infra/terraform
# terraform.tfvars:
#   processor_zip = "../../packages/pipeline/dist/handler.zip"
#   api_zip       = "../../packages/api/dist/api.zip"
terraform plan
terraform apply
```

The default zips are placeholders that throw a clear error. Do not leave those in place if you expect mail to process.

Note the outputs: bucket name, table names, API endpoint, DKIM tokens, and the DNS plan.

## 3. Verify the domain in SES (no MX change yet)

`terraform apply` creates the SES domain identity and Easy DKIM. DKIM token values show up as outputs only after apply (AWS generates them).

Add **only** the three DKIM CNAMEs to Route 53, by hand or by a second apply that still has `manage_dns = false` for everything except what you type yourself. Each record is:

```text
<token>._domainkey.cyberphysical.us.  CNAME  <token>.dkim.amazonses.com.
```

Wait until the SES console shows the identity as verified and DKIM as successful. This does not affect existing mail delivery.

## 4. Production access and warm-up

New accounts are in the SES sandbox: you can send only to verified identities, and the cap is 200 messages a day at one message per second. Receiving does not require production access. Sending to the rest of the world does.

Request production access in the SES console (Account dashboard → Request production access) for **us-west-2**:

- Mail type: transactional (this is a personal mailbox, not a campaign).
- Website: whatever you already publish, or say it is a personal domain.
- Use case, in your own words: personal mail for a single address, replacing a previous provider, low volume, no purchased lists.
- Do not request a dedicated IP.

Approval can take a day or longer. While you wait:

- Verify a second address you control and send a few messages to it.
- Confirm DKIM passes (a received message's `Authentication-Results` should show `dkim=pass`).
- Leave DMARC at `p=none` for the first week so you can see reports without rejecting anyone.

Warm-up, once production access is granted:

- Week 1: real personal mail only, a handful of messages a day. No announcements to a large list.
- Do not turn on Virtual Deliverability Manager.
- Watch the SES reputation dashboard. If complaint rate is non-zero, stop and find out why before sending more.
- Move DMARC from `p=none` to `p=quarantine` after a week of passing reports, then to `p=reject` when you are sure nothing legitimate still sends with a missing DKIM signature (old devices, old "send mail as" settings).

## 5. MAIL FROM, SPF, DMARC, MTA-STS, TLS-RPT

Custom MAIL FROM is `mail.cyberphysical.us`. It needs **exactly one** MX record:

```text
mail.cyberphysical.us.  MX  10 feedback-smtp.us-west-2.amazonses.com.
mail.cyberphysical.us.  TXT "v=spf1 include:amazonses.com ~all"
```

AWS rejects the MAIL FROM setup if that subdomain has more than one MX.

Apex SPF, only after you know whether an SPF TXT already exists (the audit will say):

```text
cyberphysical.us.  TXT "v=spf1 include:amazonses.com -all"
```

If an SPF record already exists, **edit that record** to add `include:amazonses.com`. Two SPF TXT records on the same name are a permanent error. Do not publish `-all` until you are sure no other service sends for the domain.

DMARC, start relaxed:

```text
_dmarc.cyberphysical.us.  TXT "v=DMARC1; p=none; rua=mailto:lojo@cyberphysical.us; adkim=s; aspf=s; fo=1"
```

TLS-RPT:

```text
_smtp._tls.cyberphysical.us.  TXT "v=TLSRPTv1; rua=mailto:lojo@cyberphysical.us"
```

MTA-STS, after `https://mta-sts.cyberphysical.us/.well-known/mta-sts.txt` is served (the file in this repo is `docs/mta-sts.txt`, mode `testing`):

```text
_mta-sts.cyberphysical.us.  TXT "v=STSv1; id=<yyyymmddhhmm>"
mta-sts.cyberphysical.us.   A or CNAME to the HTTPS host
```

Bump `id` whenever the policy file changes. Switch `mode: enforce` only after receiving works and you have seen a TLS report.

`terraform output dns_plan` prints this set, with the real DKIM tokens filled in after apply.

## 6. Dry-run checklist for MX cutover

Do this on a day you can watch for bounces. The zone had 17 records when this project was specified. Do not assume they are "just a website."

```bash
aws route53 list-hosted-zones-by-name --dns-name cyberphysical.us \
  --query 'HostedZones[0].Id' --output text

# Replace ZONE_ID. This is read-only.
aws route53 list-resource-record-sets --hosted-zone-id ZONE_ID \
  --output json > /tmp/cyberphysical.zone.json

node scripts/dns-audit.mjs /tmp/cyberphysical.zone.json cyberphysical.us
```

The script exits non-zero if it sees a blocker (an existing apex MX, a duplicate SPF, an existing MAIL FROM MX that is not SES). Read every warning. Then walk this list by hand:

- [ ] Record count noted. If it is not 17 anymore, the zone drifted; read the new records, do not ignore them.
- [ ] SOA and NS records identified and left untouched.
- [ ] Every A, AAAA, CNAME, and CAA that serves a website identified and left untouched.
- [ ] Every TXT that is a site verification (Google, Apple, GitHub, and similar) left untouched.
- [ ] Existing apex MX records written down, including priority and target. If they point at a live host, you need a plan for the mail that host still receives.
- [ ] Existing SPF TXT found or confirmed absent. Merge plan written down. Not a second TXT.
- [ ] Existing `_dmarc` found or confirmed absent.
- [ ] Existing `*._domainkey` records found or confirmed absent.
- [ ] `mail.cyberphysical.us` has no MX, or the one MX is the SES feedback endpoint.
- [ ] `autodiscover` / `autoconfig` records noted. They are for old clients and are not required for lojo-mail.
- [ ] DKIM CNAMEs already published and SES shows DKIM successful.
- [ ] MAIL FROM domain shows success in SES.
- [ ] A test message to a verified address passed SPF, DKIM, and DMARC.
- [ ] Receipt rule set `lojo-mail` exists and is **not** yet the active set, or you have read the currently active set and you know what you will displace.
- [ ] `terraform plan` with the intended DNS diff reviewed line by line.
- [ ] You know how to revert the apex MX (the previous values are in the zone export you just saved).

Only then:

```hcl
manage_dns                 = true
dns_cutover_confirmation   = "I-audited-the-existing-zone"
manage_active_rule_set     = true
zone_id                    = "Z..."
```

`manage_dns = true` without that exact confirmation string fails the plan on purpose. `manage_active_rule_set` replaces the region's active receipt rule set. If another identity in this account uses SES receiving, stop and add a rule to the existing set instead of activating this one.

```bash
terraform plan    # the diff should be DNS records and the active rule set, nothing surprising
terraform apply
```

Watch `aws route53 list-resource-record-sets` and an external lookup (`dig MX cyberphysical.us`) until the answer is:

```text
10 inbound-smtp.us-west-2.amazonaws.com.
```

Send a message from an outside account. Confirm it lands in S3 under `raw/` and a DynamoDB item appears. Confirm the body attribute in DynamoDB is not the plaintext.

## 7. Revert

If inbound breaks:

1. Put the previous apex MX back (from `/tmp/cyberphysical.zone.json`) immediately. DNS TTL on the records this stack creates is 300 seconds so this is a few minutes, not a day. Lower it further in `terraform.tfvars` if you want.
2. Set `manage_active_rule_set` back to false only after you have restored whatever rule set was active before. Deactivating by deleting the active association stops all SES receiving in the region.

## 8. Day-two

- Open the PWA over HTTPS, unlock with the private JWK, and confirm a real message decrypts.
- Put a $10 budget alarm on the `Project=lojo-mail` tag. See [COSTS.md](COSTS.md).
- Follow [MIGRATION.md](MIGRATION.md) for Tuta.
- Rotate the API token by writing a new SSM value and restarting the API Lambda (`aws lambda update-function-configuration` is enough to pick up a new decrypt on the next cold start; the function reads SSM per request, so a restart is not even required).
- To switch the domain later, change `domain`, apply a new identity, and repeat sections 3–6. Do not delete the old identity until mail to it can die.

## 9. Local demo, no AWS

```bash
npm ci
npm run dev
```

API on `http://127.0.0.1:8787`, web app on `http://127.0.0.1:5173`, in-memory mailbox with synthetic messages, mock LLM unless you set `LOJO_LLM_PROVIDER`. The dev token is printed in the API log and is refused if `NODE_ENV=production`.
