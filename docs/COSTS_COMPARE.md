# lojo-mail cost comparison: AWS, Google Cloud, and AI providers

Date: 30 September 2026. Prices were read on this date from the pages listed under [Sources](#sources).

Regions: AWS `us-east-1` (N. Virginia), where the SES identity already lives, and Google Cloud `us-central1` (Iowa), which is a Tier 1 region and where Google's always-free quotas apply.

[COSTS.md](COSTS.md) covers one small scenario for the current design. This document compares three usage levels, an equivalent Google Cloud build, and the AI providers. Prices marked "(estimate)" could not be confirmed on an official page in this session. Usage volumes such as log gigabytes, request counts per message, and item sizes are my assumptions, not prices. They are listed under [Assumptions](#assumptions) and also marked "(estimate)".

## Sources

All pages were read on 30 September 2026.

AWS:

- SES: <https://aws.amazon.com/ses/pricing/>
- KMS: <https://aws.amazon.com/kms/pricing/>
- Lambda: <https://aws.amazon.com/lambda/pricing/>
- API Gateway: <https://aws.amazon.com/api-gateway/pricing/>
- DynamoDB on-demand: <https://aws.amazon.com/dynamodb/pricing/on-demand/>
- S3: <https://aws.amazon.com/s3/pricing/> (the storage table on this page is drawn by script, so the per-GB rates come from the price list below)
- Bedrock: <https://aws.amazon.com/bedrock/pricing/> (per-model rates come from the price list below)
- AWS Price List API offer files for `us-east-1`, at `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<Service>/current/us-east-1/index.json`. Route 53 is global and uses `.../AmazonRoute53/current/index.json`. The files used, with their publication dates:
  - `AmazonS3` (28 September 2026)
  - `AmazonCloudWatch` (22 September 2026)
  - `AmazonRoute53` (11 September 2026)
  - `AmazonDynamoDB` (11 September 2026)
  - `awskms` (11 September 2026)
  - `AWSQueueService` (11 September 2026)
  - `AWSSecretsManager` (11 September 2026)
  - `AWSSystemsManager` (11 September 2026)
  - `AWSEvents` (24 September 2026)
  - `AmazonApiGateway` (21 September 2026)
  - `AmazonBedrock` (29 September 2026)
  - `AmazonBedrockFoundationModels` (30 September 2026)

Google Cloud:

- Cloud Run: <https://cloud.google.com/run/pricing>
- Cloud Storage: <https://cloud.google.com/storage/pricing>
- Firestore: <https://cloud.google.com/firestore/pricing>
- Cloud KMS: <https://cloud.google.com/kms/pricing>
- Pub/Sub: <https://cloud.google.com/pubsub/pricing>
- Cloud Scheduler: <https://cloud.google.com/scheduler/pricing>
- Secret Manager: <https://cloud.google.com/secret-manager/pricing>
- Cloud Logging and Monitoring: <https://cloud.google.com/stackdriver/pricing>
- Cloud DNS: <https://cloud.google.com/dns/pricing>
- Vertex AI generative AI: <https://cloud.google.com/vertex-ai/generative-ai/pricing>
- Port 25 policy: <https://docs.cloud.google.com/compute/docs/tutorials/sending-mail>

Third parties:

- Cloudflare Email Service pricing: <https://developers.cloudflare.com/email-service/platform/pricing/>
- Cloudflare Email Routing limits: <https://developers.cloudflare.com/email-routing/limits/>
- Cloudflare Workers pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- Cloudflare Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Mailgun: <https://www.mailgun.com/pricing/>
- Postmark: <https://postmarkapp.com/pricing>
- Twilio SendGrid Email API: <https://www.twilio.com/en-us/products/email-api/pricing>
- xAI models and prices: <https://docs.x.ai/docs/models>
- xAI retirement notice: <https://docs.x.ai/developers/migration/may-15-retirement>

## Scenarios

| | Low | Typical | Heavy |
| --- | ---: | ---: | ---: |
| Inbound messages per day | 30 | 100 | 300 |
| Inbound messages per month (30 days) | 900 | 3,000 | 9,000 |
| Stored mail (S3 or GCS) | 1 GB | 5 GB | 20 GB |
| Outbound messages per month | 10 | 30 | 100 |
| User AI calls per day (summaries, drafts, rewrites) | 1 | 4 | 20 |
| API requests per day (PWA and MCP) | 200 | 1,000 | 5,000 |
| Searches per day | 3 | 10 | 50 |
| CloudWatch or Cloud Logging volume per month (estimate) | 0.05 GB | 0.2 GB | 1 GB |

### Assumptions

- **Bulk mail.** 40% of inbound mail is bulk and skips AI. The other 60% gets one analysis call (2,500 input and 500 output tokens) and one embedding (500 tokens). That is 540, 1,800, and 5,400 analysed messages per month.
- **Message size.** Messages average about 75 KB, so each one is a single 256 KB SES chunk.
- **User AI calls.** Each one is 3,000 input and 600 output tokens. The Typical scenario uses 4 calls a day, the middle of "3 to 5".
- **Raw sweep.** The EventBridge rule runs every 15 minutes: 4 × 24 × 30 = 2,880 invocations per month. Each run does one S3 `LIST` and takes about 0.3 s (estimate).
- **Lambda duration.** The processor takes 2 s at 512 MB per message. API requests average 0.15 s, and user AI calls take 5 s (estimate).
- **S3 requests.** Each inbound message makes about 4 PUTs (the SES write, the sealed body, one attachment on average, and the AI-context copy) and 1 GET. The `DELETE` of raw MIME is free. About 20% of API requests fetch a body or attachment (estimate).
- **DynamoDB requests.** Each inbound message uses about 21 write units: a 3 KB message item copied into 3 GSIs with `ALL` projection, one more unit for the sparse `vectors` GSI (it carries only the key and the 344-byte packed vector), plus thread, contact, audit, and budget writes. It also uses about 5 read units. An API request reads about 20 units, 10% of API requests write about 10 units, and a search reads about 375 units (estimate). Keyword search reads the 1,000 most recent items. Semantic search reads every vector for the current embedder in one Query on the `vectors` GSI: about 400 bytes per message, so 20,000 messages are 8 MB, or about 1,000 eventually consistent read units ($0.000125) per search, ranked in the Lambda's memory (`packages/core/src/ai/vectors.ts`). Nothing scans the table and there is no vector database.
- **Index size.** DynamoDB storage including GSIs is 0.1, 0.5, and 2 GB. Base-table size, which is what PITR bills on, is 0.03, 0.15, and 0.6 GB (estimate).
- **KMS requests.** About 8 per inbound message: bucket-key and table-key refreshes after idle periods, plus one data key for the AI-context copy. Another 0.5 per API request (estimate).
- **Route 53 queries.** 5,000, 15,000, and 45,000 per month (estimate).
- **Free tiers.** Only always-free allowances are counted, not 12-month new-account offers. The account is not new, so the API Gateway 12-month free tier is ignored. The "no free tier" column shows the bill if other workloads in the account already use up the shared allowances, such as the 10 free alarms.

## Section A: the current AWS design

### Unit prices used (us-east-1)

| Item | Price |
| --- | --- |
| SES inbound, à la carte | $0.10 per 1,000 emails, plus $0.09 per 1,000 incoming 256 KB chunks |
| SES outbound, à la carte | $0.10 per 1,000 emails, plus $0.12 per GB of attachments |
| SES Essentials plan | $0.16 per 1,000 emails (outbound or Mail Manager), no monthly fee |
| S3 Standard | $0.023 per GB-month; PUT, COPY, POST, and LIST $0.005 per 1,000; GET $0.0004 per 1,000 |
| KMS | $1 per customer-managed key per month; $0.03 per 10,000 requests; 20,000 free requests per month |
| DynamoDB on-demand | $0.625 per million write units; $0.125 per million read units; $0.25 per GB-month after 25 GB free; PITR $0.20 per GB-month |
| Lambda (x86) | $0.20 per million requests; $0.0000166667 per GB-second; 1M requests and 400,000 GB-seconds free |
| API Gateway HTTP API | $1.00 per million requests (first 300 million) |
| CloudWatch | Logs $0.50 per GB ingested and $0.03 per GB-month stored; alarms $0.10 each; custom metrics $0.30 each; 10 alarms, 10 metrics, and 5 GB of logs free |
| EventBridge scheduled invocations | $0 for the first 14 million, then $1.00 per million |
| SQS standard | $0.40 per million requests; first 1 million free |
| Route 53 | $0.50 per hosted zone (first 25); $0.40 per million standard queries |
| SSM Parameter Store | Standard parameters and standard throughput have no price line (free); advanced parameters $0.05 each per month |
| Secrets Manager (not used) | $0.40 per secret per month; $0.05 per 10,000 API calls |

**SES pricing plans.** The SES page now lists Essentials, Pro ($105 per account per region per month), and Enterprise ($500) next to à la carte. Starting 21 July 2026, new account-and-region pairs with no metered SES activity since 1 June 2025 start on Essentials. The plan table prices outbound email and Mail Manager processing. It does not mention classic receipt-rule inbound, which is what this stack uses. I assume inbound stays at the à la carte rate on every plan (estimate). At these volumes, Essentials outbound adds $0.0006 to $0.006 a month over à la carte. Check the account's plan in the SES console anyway, and never choose Pro or Enterprise for this workload.

### Monthly cost per line

| Line | Low | Typical | Heavy |
| --- | ---: | ---: | ---: |
| SES inbound emails | $0.090 | $0.300 | $0.900 |
| SES inbound chunks | $0.081 | $0.270 | $0.810 |
| SES outbound | $0.001 | $0.003 | $0.010 |
| S3 storage | $0.023 | $0.115 | $0.460 |
| S3 PUT and LIST | $0.032 | $0.074 | $0.194 |
| S3 GET | $0.001 | $0.004 | $0.016 |
| KMS key | $1.000 | $1.000 | $1.000 |
| KMS requests | $0.000 | $0.057 | $0.381 |
| DynamoDB writes | $0.015 | $0.056 | $0.206 |
| DynamoDB reads | $0.020 | $0.091 | $0.451 |
| DynamoDB storage | $0.000 | $0.000 | $0.000 |
| DynamoDB PITR | $0.006 | $0.030 | $0.120 |
| Lambda requests and compute | $0.000 | $0.000 | $0.000 |
| API Gateway HTTP API | $0.006 | $0.030 | $0.150 |
| CloudWatch Logs, 4 alarms, 2 metric-filter metrics | $0.000 | $0.000 | $0.000 |
| EventBridge sweep rule | $0.000 | $0.000 | $0.000 |
| SQS dead-letter queue | $0.000 | $0.000 | $0.000 |
| Route 53 hosted zone (already paid) | $0.500 | $0.500 | $0.500 |
| Route 53 queries | $0.002 | $0.006 | $0.018 |
| SSM Parameter Store (standard, including SecureString) | $0.000 | $0.000 | $0.000 |
| **Total with always-free tiers** | **$1.78** | **$2.54** | **$5.22** |
| Lines the free tiers were covering | $1.11 | $1.39 | $2.48 |
| **Total with no free tier** | **$2.89** | **$3.93** | **$7.69** |

The Typical formulas are below. The other scenarios scale the same way.

- SES inbound: 3,000 messages × $0.10/1,000 = $0.30, and 3,000 chunks × $0.09/1,000 = $0.27.
- SES outbound: 30 × $0.10/1,000 = $0.003.
- S3 storage: 5 GB × $0.023 = $0.115.
- S3 PUT and LIST: (3,000 × 4 + 2,880 sweep LISTs) = 14,880 × $0.005/1,000 = $0.074.
- S3 GET: (3,000 + 6,000) × $0.0004/1,000 = $0.004.
- KMS requests: 39,000 requests (estimate) − 20,000 free = 19,000 × $0.03/10,000 = $0.057.
- DynamoDB: 90,000 write units × $0.625/1M = $0.056, and 727,500 read units × $0.125/1M = $0.091. PITR is 0.15 GB × $0.20 = $0.03. PITR bills on table data and local secondary indexes, not GSIs.
- Lambda: 35,880 requests and 5,982 GB-seconds. Both are far inside the free 1M requests and 400,000 GB-seconds. Without the free tier: 5,982 × $0.0000166667 = $0.100 plus 35,880 × $0.20/1M = $0.007.
- API Gateway: 30,000 × $1.00/1M = $0.03.
- CloudWatch: 4 alarms × $0.10 = $0.40 and 2 custom metrics × $0.30 = $0.60, both covered by the free 10 alarms and 10 metrics. The two log metric filters (`LoginFailures`, `RawSwept`) publish custom metrics, and they bill like any other custom metric once the free 10 are used. Log ingestion is 0.2 GB × $0.50 = $0.10 (free under 5 GB). Storage at 14-day retention is under a cent.
- EventBridge: 2,880 scheduled invocations fall inside the free 14 million.
- SQS: the dead-letter queue has no consumer and is empty unless processing fails. The alarm reads a CloudWatch metric and makes no SQS requests.
- Route 53: the hosted zone already exists, so its $0.50 is sunk and the marginal cost is $0. Queries: 15,000 × $0.40/1M = $0.006.

The "free tiers were covering" row lists the lines that are $0.00 in the table only because of an always-free allowance: CloudWatch alarms ($0.40), CloudWatch custom metrics ($0.60), log ingestion and storage, Lambda, DynamoDB storage, and the first 20,000 KMS requests.

**KMS rotation.** The Terraform sets `enable_key_rotation = true`. The KMS page says the first and second rotations each add $1 per month, capped after the second, and the price list bills "$1 per customer managed KMS key version". So the key costs $1 per month in year one, $2 in year two, and $3 from year three. That is the largest fixed line in the whole stack. Turning rotation off keeps it at $1. Whether that is worth it is a security decision, not a cost one.

**Secrets Manager, not used.** The API reads about five sensitive values from SSM: the API token, the send token, the Grok key, the session secret, and the passphrase hash. As Secrets Manager secrets they would cost 5 × $0.40 = $2.00 per month, plus about $0.05 per 10,000 reads. That would roughly double the Typical bill. SSM standard SecureString parameters are free.

## Section B: an equivalent build on Google Cloud

### Mapping

| AWS piece | Google Cloud equivalent |
| --- | --- |
| Lambda processor and API | Two Cloud Run services (request-based billing, 1 vCPU, 512 MiB, minimum instances 0) |
| API Gateway HTTP API | The Cloud Run HTTPS URL with a custom domain mapping. Google's API Gateway is not needed for one client and was not priced. |
| S3 with SSE-KMS | Cloud Storage (Standard, regional `us-central1`), optionally with CMEK |
| DynamoDB and GSIs, PITR | Firestore Standard edition (native mode) with composite indexes and PITR |
| KMS customer-managed key | Cloud KMS software key |
| S3 event notification | Cloud Storage notification to Pub/Sub, with a push subscription to Cloud Run |
| EventBridge sweep | Cloud Scheduler job calling the processor |
| SSM SecureString | Secret Manager |
| CloudWatch Logs and alarms | Cloud Logging and Cloud Monitoring alerting |
| Route 53 | Keep Route 53, or use Cloud DNS or Cloudflare DNS |
| SES inbound | **No Google Cloud equivalent.** A third party is required (see below). |
| SES outbound | **No Google Cloud equivalent.** A third party is required, called over HTTPS. |

### Unit prices used (us-central1)

| Item | Price and free allowance |
| --- | --- |
| Cloud Run, request-based | $0.000024 per vCPU-second; $0.0000025 per GiB-second; $0.40 per million requests. Free: 180,000 vCPU-seconds, 360,000 GiB-seconds, and 2 million requests per month. |
| Cloud Storage, Standard regional | $0.000027397 per GiB-hour (about $0.02 per GiB-month); Class A $0.005 per 1,000; Class B $0.0004 per 1,000. Always free: 5 GB-months, 5,000 Class A, 50,000 Class B. |
| Firestore Standard | Reads $0.03 per 100,000; writes $0.09 per 100,000; deletes $0.01 per 100,000; storage and PITR $0.000205479 per GiB-hour (about $0.15 per GiB-month). Free per day: 50,000 reads, 20,000 writes, 1 GiB stored. PITR has no free quota. |
| Cloud KMS, software key | $0.000082192 per active key version per hour ($0.06 per month); $0.03 per 10,000 cryptographic operations. Free operations apply only to Autokey keys. |
| Pub/Sub | $40 per TiB after the first 10 GiB free; 1 KB minimum per request |
| Cloud Scheduler | $0.10 per job per 31 days; 3 jobs free per billing account |
| Secret Manager | $0.06 per active secret version per month after 6 free; $0.03 per 10,000 accesses after 10,000 free |
| Cloud Logging | $0.50 per GiB after 50 GiB free per project; 30 days of retention included |
| Cloud Monitoring alerting | Free today. From no sooner than 1 September 2027: $0.35 per metric reference per month, plus $0.50 per million points returned. |
| Cloud DNS | $0.20 per managed zone per month; $0.40 per million queries; no free tier |

The Firestore and KMS pages quote hourly rates, and the per-month figures above multiply by 730 hours. Google's own examples on the KMS and Secret Manager pages give the same $0.06 for the identical hourly rate.

### Monthly cost of the Google Cloud core (before mail providers)

| Line | Low | Typical | Heavy |
| --- | ---: | ---: | ---: |
| Cloud Run (processor, API, sweep) | $0.000 | $0.000 | $0.000 |
| Cloud Storage, storage | $0.000 | $0.000 | $0.300 |
| Cloud Storage, Class A | $0.007 | $0.049 | $0.169 |
| Cloud Storage, Class B | $0.000 | $0.000 | $0.000 |
| Firestore writes | $0.000 | $0.000 | $0.000 |
| Firestore reads | $0.000 | $0.000 | $1.133 |
| Firestore storage | $0.000 | $0.000 | $0.150 |
| Firestore PITR | $0.015 | $0.075 | $0.300 |
| Cloud KMS key version | $0.060 | $0.060 | $0.060 |
| Cloud KMS operations (estimate) | $0.010 | $0.036 | $0.126 |
| Pub/Sub, Scheduler, Secret Manager, Logging | $0.000 | $0.000 | $0.000 |
| Monitoring alerts (4 policies) | $0.000 | $0.000 | $0.000 |
| **Core total with free tiers** | **$0.09** | **$0.22** | **$2.24** |
| **Core total with no free tier** | **$0.75** | **$1.57** | **$5.12** |

The Typical formulas are below. Low and Heavy are computed the same way.

- Cloud Run: 11,964 vCPU-seconds and 5,982 GiB-seconds are well inside the free 180,000 and 360,000. Without the free tier: 11,964 × $0.000024 + 5,982 × $0.0000025 + 35,880 × $0.40/1M = $0.316.
- Cloud Storage: 5 GB fits the 5 GB-months always free. Class A is (14,880 − 5,000) × $0.005/1,000 = $0.049. Cloud Storage keeps soft-deleted objects for 7 days by default, and they bill as storage. Raw MIME churn adds a little here.
- Firestore charges per document, not per 4 KB. A search that reads 1,000 index documents costs 1,000 reads. Typical reads total about 1,059,000 per month, or 35,300 per day, which fits the 50,000 free per day. Heavy reads about 175,900 per day: (175,900 − 50,000) × 30 × $0.03/100,000 = $1.13. Firestore is the line that grows fastest on Google Cloud. On DynamoDB, the same Heavy reads cost $0.45 because items are billed by size.
- Firestore PITR: 0.5 GiB × $0.15 = $0.075, with no free quota.
- Cloud KMS: 1 key version × $0.06. Operations are about 12,000 (estimate) × $0.03/10,000 = $0.036. Unlike AWS, each rotation creates a new version that stays billable until it is destroyed, at $0.06 per version. So yearly rotation adds $0.06 per year of history rather than AWS's $1 per rotation.
- Scheduler (1 job) and Secret Manager (5 secrets) fit their free allowances. Without them they cost $0.10 and $0.30.
- Monitoring: when alerting charges begin (no sooner than September 2027), 4 policies × $0.35 = $1.40 per month.
- DNS is $0 if the zone stays on Route 53 or moves to Cloudflare. Moving it to Cloud DNS costs $0.20 per month plus about $0.006 in queries.

### Mail in and out: Google Cloud has no mail service

Google Cloud has no inbound email receiving service; nothing plays the role of an SES receipt rule. Google's Compute Engine documentation also says that connections to destination TCP port 25 outside your VPC network are blocked, and it points to SendGrid, Mailgun, or Mailjet instead. Cloud Run cannot run an MX host either: it serves HTTP(S) only, so it cannot listen on port 25 (estimate; not re-checked this session). A Google Cloud build therefore needs a third party for both directions, called over HTTPS.

| Option | Direction | Monthly price (official page) | Fit for lojo-mail |
| --- | --- | --- | --- |
| Cloudflare Email Routing + Email Worker, Workers Free | Inbound | $0. Routing is unlimited; Workers Free allows 100,000 requests per day and 10 ms of CPU per invocation. | Works if the Worker only streams the raw message to Cloud Run. Heavy parsing can fail with `EXCEEDED_CPU`. Inbound messages up to 25 MiB. |
| Cloudflare Workers Paid | Inbound and outbound | $5 per month. Includes 10 million requests and 3,000 outbound emails, then $0.35 per 1,000 emails. | Covers all three scenarios for both directions with one vendor. |
| Mailgun Free | Inbound and outbound | $0. 100 emails per day, 1 inbound route. | Whether received mail counts toward the 100-per-day cap is not stated on the page (estimate). Heavy would exceed it if it does. |
| Mailgun Basic / Foundation | Inbound and outbound | $15 per month (10,000 emails, 5 inbound routes) or $35 per month ("full access to inbound routing") | Works, at 15 to 35 times the cost of the rest of the stack. |
| Postmark Pro | Inbound and outbound | $16.50 per month for 10,000 emails. Inbound is not on the $15 Basic plan. | Heavy (about 9,100 sent plus received) fits in 10,000. The page's volume question asks what you "send and receive". |
| Twilio SendGrid Essentials | Inbound (Inbound Parse Webhook) and outbound | $19.95 per month for 50,000 emails. The free option is a 60-day trial at 100 emails per day. | Works; the most expensive choice here. |
| Keep SES inbound only | Inbound | $0.17, $0.57, or $1.71 per month (Section A), plus a few cents of S3 and a forwarding Lambda | Keeps an AWS account and KMS key anyway, which removes most of the reason to move. |
| SES outbound over the HTTPS API | Outbound | $0.001 to $0.01 per month at these volumes | Cheapest outbound. Requires keeping the AWS account and the SES identity. |

The Cloudflare options need the domain's DNS on Cloudflare. As far as I know, Email Routing requires Cloudflare to be the authoritative DNS for the zone, but I did not verify that this session (estimate). That would mean moving the zone off Route 53 and redoing MX, SPF, DKIM, DMARC, and MTA-STS.

### Google Cloud totals with a mail option

| Build (with free tiers) | Low | Typical | Heavy |
| --- | ---: | ---: | ---: |
| GCP core + Cloudflare Free inbound + SES outbound | $0.09 | $0.22 | $2.25 |
| GCP core + Cloudflare Workers Paid (both directions) | $5.09 | $5.22 | $7.24 |
| GCP core + Mailgun Basic | $15.09 | $15.22 | $17.24 |
| GCP core + Postmark Pro | $16.59 | $16.72 | $18.74 |
| GCP core + SendGrid Essentials | $20.04 | $20.17 | $22.19 |
| For comparison: current AWS design | $1.78 | $2.54 | $5.22 |

The cheapest Google Cloud build looks $1.70 to $3.00 a month cheaper than AWS. Almost all of that gap is two lines: the $1 AWS KMS key compared with a $0.06 Cloud KMS key version, and SES inbound at about $0.19 per 1,000 messages compared with free Cloudflare routing. Getting there means rewriting the DynamoDB, S3, and KMS adapters, moving DNS and MX to Cloudflare, adding a second vendor to the mail path, and still keeping AWS for outbound SES. Every paid inbound provider costs more than the entire AWS stack.

### Data-security differences

- **Who sees plaintext.** Every inbound path sees the message in plaintext before lojo-mail seals it: SES, Cloudflare, Mailgun, Postmark, and SendGrid alike. Only OpenPGP mail stays end-to-end, as in [SECURITY.md](SECURITY.md).
- **Where plaintext sits afterwards.** With SES, it lands in your own bucket under your own CMK and is deleted after ingest. The third parties are another place it may be stored. Postmark keeps 45 days of full message content by default (7 to 365 days on Pro via an add-on). Mailgun lists 1 day of message retention on Foundation. Cloudflare's pages read for this document say nothing about content retention, so check before relying on it.
- **Encryption at rest.** Cloud Storage and Firestore encrypt with Google-managed keys by default. To match the AWS design's customer-managed key, you have to configure CMEK with Cloud KMS explicitly. Google-managed keys cost nothing but give you no key policy, no key-level audit trail, and no ability to disable the key.
- **Unchanged either way.** The per-message P-256 envelope to Jon's key protects bodies against the cloud operator in both designs, because the private key is never in the cloud.

## Section C: AI provider costs

### Token math

| | Low | Typical | Heavy |
| --- | ---: | ---: | ---: |
| Analysed messages per month (60% of inbound) | 540 | 1,800 | 5,400 |
| Analysis input tokens (× 2,500) | 1,350,000 | 4,500,000 | 13,500,000 |
| Analysis output tokens (× 500) | 270,000 | 900,000 | 2,700,000 |
| Embedding tokens (× 500) | 270,000 | 900,000 | 2,700,000 |
| User calls per month | 30 | 120 | 600 |
| User input tokens (× 3,000) | 90,000 | 360,000 | 1,800,000 |
| User output tokens (× 600) | 18,000 | 72,000 | 360,000 |
| Tokens per day, all AI | 66,600 | 224,400 | 702,000 |

Search query embeddings add about 20 tokens per search, which is too small to matter.

**The daily token budget.** The default `daily_token_budget` is 100,000 tokens, and embeddings count toward it. Low fits. Typical exceeds it by about 2.2 times and Heavy by about 7 times. Once the day's budget is spent, later messages are stored without a summary (`budget_exceeded`). To get the costs below at Typical or Heavy, raise the budget to about 250,000 or 750,000.

With the default budget, monthly AI spend is capped at about 3 million tokens. With five parts input to one part output, that caps the bill at about 3.0M × (0.833 × $1.10 + 0.167 × $5.50) / 1M = $5.50 on Claude Haiku 4.5, and about $4.38 on `grok-4.3`.

### Model prices (per million tokens, input / output)

| Model | Price | Where the price comes from |
| --- | --- | --- |
| Amazon Nova Micro | $0.035 / $0.14 | AWS price list, `USE1-NovaMicro-input-tokens` and `-output-tokens` |
| Amazon Nova Lite | $0.06 / $0.24 | AWS price list |
| Amazon Nova Pro | $0.80 / $3.20 | AWS price list |
| Claude Haiku 4.5 on Bedrock | $1.10 / $5.50 regional, $1.00 / $5.00 global | AWS price list, Marketplace SKUs |
| Meta Llama 3.2 1B / 3B / Llama 3.1 8B on Bedrock | $0.10 / $0.10; $0.15 / $0.15; $0.22 / $0.22 | AWS price list |
| Amazon Titan Text Embeddings V2 | $0.02 input | AWS price list |
| Gemini 2.5 Flash-Lite (Vertex AI) | $0.10 / $0.40 | Vertex AI pricing page |
| Gemini 3.1 Flash-Lite (Vertex AI, global) | $0.25 / $1.50 | Vertex AI pricing page |
| Gemini Embedding (Vertex AI) | $0.15 input ($0.00015 per 1,000) | Vertex AI pricing page |
| Vertex text embeddings other than Gemini Embedding (for example `text-embedding-005`) | $0.000025 per 1,000 | Vertex AI pricing page. The page's unit is "count", which I read as characters (estimate). |
| xAI `grok-build-0.1` (cheapest text model listed) | $1.00 / $2.00 | xAI models page |
| xAI `grok-4.3` | $1.25 / $2.50 | xAI models page |
| xAI `grok-3-mini` (Terraform default) | Not listed | See the note below. |

**Embeddings are off in the deployed stack until chosen.** The Terraform default is `embed_provider = "none"`, so the next apply adds no embedding cost. Setting `embed_provider = "bedrock"` (Titan V2 at 256 dimensions) is the Section C "Titan V2" column. Local and importer runs default to Ollama `nomic-embed-text`, which is free. Gemini API keys from AI Studio bill at the Gemini API rates, which I assume match the Vertex rates for Flash-Lite (estimate; the Gemini API pricing page was not read this session).

**Bedrock notes.** The Terraform default `bedrock_model_id` is the `us.` geographic inference profile. I assume it bills at the "Regional" Haiku rate, 10% above global (estimate). Titan Embeddings V2 is the embedding model paired with every Bedrock and xAI chat model below, because xAI lists no embedding model. Before relying on Llama 3.2, check in the console that it is enabled on demand in `us-east-1`.

**xAI note.** The fast, cheap Grok models are gone. xAI retired `grok-4-fast-*`, `grok-4-1-fast-*`, `grok-3`, and others on 15 May 2026. Their names still work, but requests are served by `grok-4.3` and billed at $1.25 / $2.50. `grok-3-mini`, which is the Terraform default, is neither on the models page nor on the retirement list, and its model page returns 404. Assume it now costs the same as `grok-4.3` or fails outright (estimate), and change `grok_model` explicitly. When reasoning effort is above `none`, `grok-4.3` also bills reasoning tokens as output, so real Grok costs run above the table.

**OpenAI-compatible providers.** `llm_provider = "openai"` speaks the OpenAI `/v1/chat/completions` protocol to any compatible endpoint set in `openai_base_url` (OpenAI, OpenRouter, Groq, Together, a self-hosted vLLM), and `embed_provider = "openai"` uses its `/v1/embeddings`. The cost is simply (input tokens × input price) + (output tokens × output price), using the token table above. For example, a provider charging $0.10 / $0.40 would cost the same as Gemini 2.5 Flash-Lite.

### Monthly AI cost per scenario

The analysis column prices the ingest calls, embeddings are priced with the paired model, and user calls are the user's summaries, drafts, and rewrites. Local Ollama costs $0 in every column.

Low:

| Provider and model | Analysis | Embeddings | User calls | Total |
| --- | ---: | ---: | ---: | ---: |
| Local Ollama (`llama3.2:1b`, `nomic-embed-text`) | $0 | $0 | $0 | $0 (electricity about $0.01, estimate) |
| Bedrock Nova Micro + Titan V2 | $0.09 | $0.005 | $0.006 | $0.10 |
| Bedrock Nova Lite + Titan V2 | $0.15 | $0.005 | $0.010 | $0.16 |
| Bedrock Nova Pro + Titan V2 | $1.94 | $0.005 | $0.130 | $2.08 |
| Bedrock Claude Haiku 4.5 (us. profile) + Titan V2 | $2.97 | $0.005 | $0.198 | $3.17 |
| Bedrock Llama 3.2 1B + Titan V2 | $0.16 | $0.005 | $0.011 | $0.18 |
| Bedrock Llama 3.2 3B + Titan V2 | $0.24 | $0.005 | $0.016 | $0.26 |
| Bedrock Llama 3.1 8B + Titan V2 | $0.36 | $0.005 | $0.024 | $0.39 |
| Vertex Gemini 2.5 Flash-Lite + Gemini Embedding | $0.24 | $0.041 | $0.016 | $0.30 |
| Vertex Gemini 3.1 Flash-Lite + Gemini Embedding | $0.74 | $0.041 | $0.050 | $0.83 |
| xAI `grok-build-0.1` + Titan V2 | $1.89 | $0.005 | $0.126 | $2.02 |
| xAI `grok-4.3` (or `grok-3-mini` redirected) + Titan V2 | $2.36 | $0.005 | $0.158 | $2.53 |

Typical:

| Provider and model | Analysis | Embeddings | User calls | Total |
| --- | ---: | ---: | ---: | ---: |
| Local Ollama | $0 | $0 | $0 | $0 (electricity about $0.02, estimate) |
| Bedrock Nova Micro + Titan V2 | $0.28 | $0.018 | $0.023 | $0.32 |
| Bedrock Nova Lite + Titan V2 | $0.49 | $0.018 | $0.039 | $0.54 |
| Bedrock Nova Pro + Titan V2 | $6.48 | $0.018 | $0.518 | $7.02 |
| Bedrock Claude Haiku 4.5 (us. profile) + Titan V2 | $9.90 | $0.018 | $0.792 | $10.71 |
| Bedrock Llama 3.2 1B + Titan V2 | $0.54 | $0.018 | $0.043 | $0.60 |
| Bedrock Llama 3.2 3B + Titan V2 | $0.81 | $0.018 | $0.065 | $0.89 |
| Bedrock Llama 3.1 8B + Titan V2 | $1.19 | $0.018 | $0.095 | $1.30 |
| Vertex Gemini 2.5 Flash-Lite + Gemini Embedding | $0.81 | $0.135 | $0.065 | $1.01 |
| Vertex Gemini 3.1 Flash-Lite + Gemini Embedding | $2.48 | $0.135 | $0.198 | $2.81 |
| xAI `grok-build-0.1` + Titan V2 | $6.30 | $0.018 | $0.504 | $6.82 |
| xAI `grok-4.3` (or `grok-3-mini` redirected) + Titan V2 | $7.88 | $0.018 | $0.630 | $8.52 |

Heavy:

| Provider and model | Analysis | Embeddings | User calls | Total |
| --- | ---: | ---: | ---: | ---: |
| Local Ollama | $0 | $0 | $0 | $0 (electricity about $0.07, estimate) |
| Bedrock Nova Micro + Titan V2 | $0.85 | $0.054 | $0.113 | $1.02 |
| Bedrock Nova Lite + Titan V2 | $1.46 | $0.054 | $0.194 | $1.71 |
| Bedrock Nova Pro + Titan V2 | $19.44 | $0.054 | $2.592 | $22.09 |
| Bedrock Claude Haiku 4.5 (us. profile) + Titan V2 | $29.70 | $0.054 | $3.960 | $33.71 |
| Bedrock Llama 3.2 1B + Titan V2 | $1.62 | $0.054 | $0.216 | $1.89 |
| Bedrock Llama 3.2 3B + Titan V2 | $2.43 | $0.054 | $0.324 | $2.81 |
| Bedrock Llama 3.1 8B + Titan V2 | $3.56 | $0.054 | $0.475 | $4.09 |
| Vertex Gemini 2.5 Flash-Lite + Gemini Embedding | $2.43 | $0.405 | $0.324 | $3.16 |
| Vertex Gemini 3.1 Flash-Lite + Gemini Embedding | $7.42 | $0.405 | $0.990 | $8.82 |
| xAI `grok-build-0.1` + Titan V2 | $18.90 | $0.054 | $2.520 | $21.47 |
| xAI `grok-4.3` (or `grok-3-mini` redirected) + Titan V2 | $23.62 | $0.054 | $3.150 | $26.83 |

Worked example, Typical on Nova Micro: analysis is 4.5M × $0.035 + 0.9M × $0.14 = $0.1575 + $0.126 = $0.28. Embeddings are 0.9M × $0.02 = $0.018. User calls are 0.36M × $0.035 + 0.072M × $0.14 = $0.023. The total is $0.32.

Using `text-embedding-005` instead of Gemini Embedding lowers the Vertex embedding line to about $0.03, $0.09, and $0.27. That assumes about 2,000 characters per 500 tokens at $0.000025 per 1,000 characters (estimate).

**Ollama electricity (estimate).** Assume the lab machine draws 50 W extra while inferring, about 4.5 s per message (analysis plus embedding) and 6 s per user call, with power at $0.17 per kWh. Typical is 1,800 × 4.5 s + 120 × 6 s = 8,820 s, which is 2.45 hours × 50 W = 0.12 kWh, or about $0.02. Low is about $0.01 and Heavy about $0.07. If the machine would be idle anyway, that is the whole marginal cost.

## Section D: recommendation

**Stay on AWS.** SES is the only native inbound mail service in either cloud, and the AWS side of lojo-mail costs $1.78, $2.54, or $5.22 a month with the always-free tiers ($2.89, $3.93, or $7.69 without them). The $1 KMS key and the already-paid $0.50 Route 53 zone are the fixed floor. Without free tiers, the 4 alarms ($0.40) and 2 metric-filter metrics ($0.60) come next. Variable costs only pass a dollar at Heavy volume, and SES inbound is the largest of them.

**AI.** Use local Ollama whenever the lab machine does the work: local development, the importer, or a lab-side worker. It is free. The deployed processor Lambda cannot reach `http://100.96.1.90:11434`, because that is a tailnet address, and this stack deliberately creates no VPC, NAT, or tunnel to reach it (see `ollama_base_url` in `infra/terraform/variables.tf`). For AI inside AWS, use Bedrock with Nova Micro (or Nova Lite for better writing) and Titan Text Embeddings V2. That costs $0.10 to $1.71 a month across all three scenarios, keeps the AI invoice in the same account, and keeps mail text inside AWS.

Claude Haiku 4.5 and the current Grok models cost 20 to 35 times as much as Nova Micro at these token counts. The default 100,000-token daily budget stops them from reaching the table figures, at the price of leaving most Typical and Heavy mail unsummarised. If Grok stays the provider, change `grok_model` from `grok-3-mini` to an explicit current model. The old slug no longer carries its old price and may not work at all.

**When Google Cloud would make sense.**

- If the domain moves to Cloudflare DNS for other reasons, so free Cloudflare Email Routing costs no migration work.
- If the AWS account has to go away entirely. Outbound would then need Cloudflare Workers Paid ($5), Mailgun, Postmark, or SendGrid. Each of those alone costs more than the whole AWS stack.
- If the index moves to a Firestore-specific feature, such as native vector search, or the team standardises on the existing Google Cloud project.

A saving of about $2 a month does not justify rewriting the storage adapters or adding a vendor to the mail path.

### Cost risks to watch

| Risk | Price | Why it matters here |
| --- | --- | --- |
| KMS key rotation | +$1 per month for each of the first two rotations | The stack enables rotation, so the key reaches $3 per month from year three. |
| Secrets Manager instead of SSM | $0.40 per secret per month | About $2 per month for five values. SSM standard is free. |
| NAT gateway (for example, to reach Ollama from Lambda through a VPC) | About $0.045 per hour, or about $33 per month, plus data processing (estimate; not checked this session) | Ten times the whole stack. Use a tunnel or keep Ollama local instead. |
| OpenSearch Serverless for search | Minimum capacity units billed around the clock, on the order of $175 per month or more (estimate; not checked this session) | Semantic search is one Query on a sparse GSI plus an in-memory cosine pass. Do not add it. |
| SES dedicated IP | $24.95 per month per IP (managed: $15 per month plus a per-email fee) | Wrong product at this volume. |
| Virtual Deliverability Manager | $0.07 per 1,000 emails, plus query fees | Small at this volume, but not useful. |
| SES Pro or Enterprise plan | $105 or $500 per month per region | Easy to click, and 40 to 200 times the stack. |
| SES Mail Manager ingress endpoint | $50 per month per endpoint, even when "Closed" | Not needed. Receipt rules do the job. |
| CloudWatch log ingestion | $0.50 per GB | A debug log of bodies or prompts at Heavy volume could add dollars. Keep API Gateway access logs off and never log bodies. |
| CloudWatch free-tier exhaustion | $0.10 per alarm, $0.30 per custom metric | $1.00 per month here if other workloads use up the free 10 alarms and 10 metrics. |
| Unbounded AI budget | Section C | Raising `daily_token_budget` without switching to Nova or Llama makes AI the largest line. Set a provider-side spend limit too. |
| On Google Cloud: Firestore reads | $0.03 per 100,000 documents | Billed per document, so searches and list pages grow faster than on DynamoDB. |
| On Google Cloud: Monitoring alerting | $0.35 per metric reference from September 2027 | $1.40 per month for four alerts. |
