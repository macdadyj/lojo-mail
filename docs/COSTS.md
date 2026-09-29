# lojo-mail monthly cost

Target: a few dollars a month at personal volume. No always-on instance, no dedicated IP, no Virtual Deliverability Manager, no Secrets Manager secrets (those are $0.40 each). The floor is the KMS key.

Prices below were checked against the public SES price page and the SES pricing-plans docs as of September 2026. AWS changes prices. Re-check before believing a line item to the cent.

## Assumptions

- Region `us-east-1`. A read-only audit found SES for this domain already there. Prices in that region match the figures below at this volume.
- About 400 messages in and 150 messages out per month. Most messages under 256 KB. A few megabytes of attachments.
- Stored mail under 1 GB. Bodies and attachments are S3 objects; DynamoDB holds only small index items.
- One customer-managed KMS key with rotation.
- DynamoDB on-demand, tables essentially empty.
- Lambda well inside the always-free monthly compute.
- API Gateway HTTP API, a few thousand requests.
- CloudWatch retention 14 days, little log volume because AI prompts are not logged.
- SES shared IP pool. Dedicated IPs are about $25 per address and are the wrong product at this volume.
- VDM left off. It adds about $0.07 per 1,000 emails and is not worth it here.
- No CloudFront distribution in the default Terraform.

## SES price plans

À la carte inbound and outbound are **$0.10 per 1,000** emails. Inbound also bills **$0.09 per 1,000 chunks**, and a chunk is 256 KB (a small message is one chunk).

As of this writing (re-check the pricing page; the review could not independently confirm these two lines), since 21 July 2026 new SES account/region pairs with no recent metered use start on the **Essentials** plan at **$0.16 per 1,000** under 10 million emails, not on à la carte. Essentials has no monthly fee. At a few hundred messages the difference is a few cents, but you should still open the SES pricing-plan page and switch to à la carte unless you specifically want the bundled features. Do not pick Pro ($105 per month per account per region) or Enterprise.

Outbound attachment data on à la carte is an extra $0.12 per GB. Irrelevant at personal size.

## Estimate

| Line | À la carte, AI on Ollama | À la carte, AI on Grok | Notes |
| --- | ---: | ---: | --- |
| KMS key | $1.00 | $1.00 | $1 per CMK per month. This is the fixed cost. |
| KMS requests | ~$0.03 | ~$0.05 | $0.03 per 10,000 requests. Bucket keys keep S3 from calling KMS per object. |
| S3 storage + a few thousand requests | ~$0.05 | ~$0.05 | $0.023/GB-month standard. Raw MIME is deleted after ingest (7-day safety net); the AI-context copies expire after 30 days. Noncurrent versions expire after 1 day for `raw/` and `ai-context/`, 30 days elsewhere. |
| DynamoDB on-demand + PITR | ~$0.10 | ~$0.10 | Pennies of requests. Reads are index `Query` calls, not scans. Six GSIs double write units for indexed items, still pennies. PITR is $0.20/GB-month. |
| Lambda | $0.00 | $0.00 | Inside the free tier at this volume. |
| API Gateway HTTP API | $0.00 | $0.00 | $1.00 per million requests. |
| CloudWatch logs | ~$0.25 | ~$0.40 | Ingestion is the risk. 14-day retention is set so a bug cannot grow a log group forever. |
| SES in + out + chunks | ~$0.10 | ~$0.10 | 550 messages × $0.10/1,000, plus a handful of chunks. |
| SSM Parameter Store | $0.00 | $0.00 | Standard parameters, including SecureString. No Secrets Manager. |
| SQS DLQ + two CloudWatch alarms | ~$0.20 | ~$0.20 | $0.10 per standard alarm; the queue is empty unless processing fails. |
| LLM | $0.00 | ~$0.50–$2 | Ollama on the lab host is already paid for. A `grok-3-mini`-class model under the 100k-token daily cap costs about this at this volume. |
| **Total** | **about $1.50–$2.50** | **about $2–$5** | |

If the account is left on Essentials, add a few cents of SES, not dollars.

## What would blow the budget

- A dedicated IP (~$24.95) "for deliverability." Do not.
- Virtual Deliverability Manager.
- Secrets Manager instead of SSM.
- CloudFront plus a second NAT gateway. Not in this design.
- An idle RDS, OpenSearch, or MSK. Not in this design. Semantic search is cosine similarity over a few thousand stored vectors.
- A generous Grok model with no daily cap. The cap is `daily_token_budget` (default 100,000 tokens). When it is spent, further messages are stored and the audit row says `budget_exceeded`. They are not summarized.
- Enabling API Gateway access logs and then logging bodies. The Terraform flag defaults off, and the app does not log bodies.
- Leaving raw MIME forever. Storage stays cheap, but the plaintext-under-KMS copy is the reason retention exists, not the bill. The processor deletes it after indexing.
- Storing attachments in DynamoDB. The item limit is 400 KB and storage is about ten times S3's price, which is why bodies and attachments are S3 objects.

## AI cost guard

The pipeline truncates body text to `max_body_chars` (default 8,000) before the prompt, skips bulk mail, and refuses to call the provider once the UTC day's token counter reaches the budget. Embeddings count toward the same budget. The cap is checked before each call and charged after it, so concurrent calls can overshoot it. [SECURITY.md](SECURITY.md#ai) says by how much. For a hard ceiling, set a spending limit at the model provider. The audit log is the place to see whether the cap is tight.

Ollama (`llama3.2:1b` and `nomic-embed-text` on `http://100.96.1.90:11434`) is the way to keep the whole system near two dollars. Grok is the default provider because it is the better writer; point `llm_provider` at `ollama` if the bill matters more than the prose. Bedrock is the same interface if you would rather keep the AI invoice inside AWS. Check the Bedrock model price before choosing one. Haiku-class models stay in the "a few dollars" band at this volume; large models do not.

## Cost alarm Jon should create by hand

Not in Terraform, because a budget is account-scoped and this project should not touch account-level billing resources casually:

```bash
aws budgets create-budget --account-id "$ACCOUNT_ID" --budget file://budget.json
```

A $10 monthly cost budget filtered to the `Project=lojo-mail` tag, plus an email to Jon at 80% forecasted, is enough. Every resource in this stack carries that tag.
