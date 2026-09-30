# First deploy: live test before real mail

This is the go/no-go check for the first `terraform apply`. It proves, with one test message to a test address, that SES can write into the KMS-encrypted bucket and that the processor picks the message up, seals it, and indexes it. Real mail to `lojo@cyberphysical.us` stays untouched until the last step.

Run this as the apply principal from [RUNBOOK.md](RUNBOOK.md#who-can-apply), in us-east-1.

## Required permissions

The apply principal needs exactly the actions below. The same set is in [`infra/iam/apply-policy.json`](../infra/iam/apply-policy.json), ready to attach. `scripts/apply-policy.test.mjs` fails CI when a new Terraform resource type has no matching actions there. Every resource carries `default_tags`, so each service also needs its tagging actions.

| Service | Actions |
| --- | --- |
| Identity | `sts:GetCallerIdentity` |
| KMS | `kms:CreateKey`, `kms:DescribeKey`, `kms:GetKeyPolicy`, `kms:PutKeyPolicy`, `kms:GetKeyRotationStatus`, `kms:EnableKeyRotation`, `kms:ListResourceTags`, `kms:TagResource`, `kms:UntagResource`, `kms:ScheduleKeyDeletion`, `kms:CreateAlias`, `kms:UpdateAlias`, `kms:DeleteAlias`, `kms:ListAliases`, `kms:CreateGrant` |
| S3 | `s3:CreateBucket`, `s3:DeleteBucket`, `s3:ListBucket`, `s3:GetBucketLocation`, `s3:GetBucketTagging`, `s3:PutBucketTagging`, `s3:GetBucketAcl`, `s3:GetBucketCORS`, `s3:PutBucketCORS`, `s3:GetBucketWebsite`, `s3:GetBucketVersioning`, `s3:PutBucketVersioning`, `s3:GetAccelerateConfiguration`, `s3:GetBucketRequestPayment`, `s3:GetBucketLogging`, `s3:GetLifecycleConfiguration`, `s3:PutLifecycleConfiguration`, `s3:GetReplicationConfiguration`, `s3:GetEncryptionConfiguration`, `s3:PutEncryptionConfiguration`, `s3:GetBucketObjectLockConfiguration`, `s3:GetBucketPolicy`, `s3:PutBucketPolicy`, `s3:DeleteBucketPolicy`, `s3:GetBucketPublicAccessBlock`, `s3:PutBucketPublicAccessBlock`, `s3:GetBucketOwnershipControls`, `s3:PutBucketOwnershipControls`, `s3:GetBucketNotification`, `s3:PutBucketNotification` |
| DynamoDB | `dynamodb:CreateTable`, `dynamodb:DescribeTable`, `dynamodb:UpdateTable`, `dynamodb:DeleteTable`, `dynamodb:DescribeContinuousBackups`, `dynamodb:UpdateContinuousBackups`, `dynamodb:DescribeTimeToLive`, `dynamodb:UpdateTimeToLive`, `dynamodb:ListTagsOfResource`, `dynamodb:TagResource`, `dynamodb:UntagResource` |
| IAM (roles `lojo-mail-*`) | `iam:CreateRole`, `iam:GetRole`, `iam:DeleteRole`, `iam:UpdateAssumeRolePolicy`, `iam:TagRole`, `iam:UntagRole`, `iam:ListRolePolicies`, `iam:ListAttachedRolePolicies`, `iam:ListInstanceProfilesForRole`, `iam:PutRolePolicy`, `iam:GetRolePolicy`, `iam:DeleteRolePolicy` |
| IAM PassRole (to Lambda only) | `iam:PassRole` |
| Lambda | `lambda:CreateFunction`, `lambda:GetFunction`, `lambda:GetFunctionConfiguration`, `lambda:GetFunctionCodeSigningConfig`, `lambda:ListVersionsByFunction`, `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration`, `lambda:DeleteFunction`, `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency`, `lambda:GetFunctionConcurrency`, `lambda:ListTags`, `lambda:TagResource`, `lambda:UntagResource`, `lambda:AddPermission`, `lambda:RemovePermission`, `lambda:GetPolicy`, `lambda:PutFunctionEventInvokeConfig`, `lambda:UpdateFunctionEventInvokeConfig`, `lambda:GetFunctionEventInvokeConfig`, `lambda:DeleteFunctionEventInvokeConfig` |
| SQS | `sqs:CreateQueue`, `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`, `sqs:SetQueueAttributes`, `sqs:DeleteQueue`, `sqs:ListQueueTags`, `sqs:TagQueue`, `sqs:UntagQueue` |
| CloudWatch Logs | `logs:CreateLogGroup`, `logs:DeleteLogGroup`, `logs:DescribeLogGroups`, `logs:PutRetentionPolicy`, `logs:DeleteRetentionPolicy`, `logs:ListTagsForResource`, `logs:ListTagsLogGroup`, `logs:TagResource`, `logs:UntagResource`, `logs:PutMetricFilter`, `logs:DeleteMetricFilter`, `logs:DescribeMetricFilters` |
| CloudWatch alarms | `cloudwatch:PutMetricAlarm`, `cloudwatch:DescribeAlarms`, `cloudwatch:DeleteAlarms`, `cloudwatch:ListTagsForResource`, `cloudwatch:TagResource`, `cloudwatch:UntagResource` |
| EventBridge (raw/ sweep) | `events:PutRule`, `events:DescribeRule`, `events:DeleteRule`, `events:ListTagsForResource`, `events:TagResource`, `events:UntagResource`, `events:PutTargets`, `events:RemoveTargets`, `events:ListTargetsByRule` |
| API Gateway (HTTP API) | `apigateway:GET`, `apigateway:POST`, `apigateway:PUT`, `apigateway:PATCH`, `apigateway:DELETE` |
| SES | `ses:GetEmailIdentity`, `ses:CreateReceiptRuleSet`, `ses:DescribeReceiptRuleSet`, `ses:DeleteReceiptRuleSet`, `ses:CreateReceiptRule`, `ses:DescribeReceiptRule`, `ses:UpdateReceiptRule`, `ses:DeleteReceiptRule`, `ses:SetActiveReceiptRuleSet`, `ses:DescribeActiveReceiptRuleSet`, `ses:CreateConfigurationSet`, `ses:GetConfigurationSet`, `ses:DeleteConfigurationSet`, `ses:PutConfigurationSetDeliveryOptions`, `ses:PutConfigurationSetReputationOptions`, `ses:PutConfigurationSetSendingOptions`, `ses:ListTagsForResource`, `ses:TagResource`, `ses:UntagResource` |

Notes:

- **`cloudwatch:PutMetricAlarm`** creates the four alarms: processor DLQ not empty, processor errors, sign-in failures, and raw/ swept. `cloudwatch:DescribeAlarms` reads them back, `cloudwatch:TagResource` applies the default tags, and `cloudwatch:DeleteAlarms` is used on destroy. Without them the apply stops partway.
- `kms:CreateGrant` is needed because the DynamoDB tables are encrypted with the stack's key.
- The policy uses `"Resource": "*"` except for IAM and API Gateway, because bucket, table, and key names are generated at apply. After the first apply you can narrow it to the `lojo-mail-*` names and the key ARN.
- Only with `ses_identity_mode = "create"`: `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`, `ses:DeleteEmailIdentity`, `ses:PutEmailIdentityMailFromAttributes`, `ses:PutEmailIdentityDkimSigningAttributes`. Only with `manage_dns = true`: `route53:GetHostedZone`, `route53:ListResourceRecordSets`, `route53:ChangeResourceRecordSets`, `route53:GetChange`. Neither applies to this domain's defaults.
- The checks below read state and need more actions: `ses:DescribeActiveReceiptRuleSet`, `s3:GetObject`, `s3:PutObject` (for the trigger test), `s3:ListBucket`, `kms:Decrypt` and `kms:GenerateDataKey` on the stack's key, `dynamodb:Query`, `logs:FilterLogEvents`, `sqs:GetQueueAttributes`, `cloudwatch:DescribeAlarms`, `cloudwatch:GetMetricStatistics`, `lambda:GetPolicy`, `lambda:GetFunctionConcurrency`, `lambda:InvokeFunction` (manual sweep only), and `events:DescribeRule`.
- If an apply stops with `AccessDenied`, fix the policy and run a full `terraform apply` again. Do not use `-target` to finish it: a targeted apply skips the resources and dependencies it does not name, which is how a trigger or an ordering guarantee gets left out.

## How mail gets from raw/ to the processor

1. **S3 event notification (primary).** `aws_s3_bucket_notification.raw` sends every `s3:ObjectCreated:*` under `raw/` to `lojo-mail-processor`. S3 may invoke it only for this bucket and this account (`aws_lambda_permission.s3_invoke`, with `source_arn` and `source_account`). A message is normally indexed within seconds.
2. **Scheduled sweep (safety net).** EventBridge rule `lojo-mail-raw-sweep` invokes the processor every `raw_sweep_minutes` (15 by default) with `{"lojo":"sweep-raw"}`. The processor lists `raw/` and ingests anything older than 5 minutes, up to 25 per run. It skips the SES setup object. Ingest is idempotent per raw key, so a message the notification also handled is stored once. Each pickup logs `raw_swept`, and alarm **`lojo-mail-raw-swept`** fires. So mail keeps flowing when the notification is broken, and you still find out. A message that fails in the sweep stays in `raw/`, the run fails, and the processor-errors alarm fires.
3. **Creation order.** The receipt rule is created only after the key, the bucket's SSE-KMS configuration, the bucket policy, the Lambda permission, and the notification exist. The rule set is activated only after the rule exists. Earlier, SES could write before bucket encryption existed; the setup object from the first test deploy was AES256 for that reason. `scripts/check-tf-order.mjs` checks this order in `terraform graph`, and it runs in `npm run infra:validate` and CI.

`aws_s3_bucket_notification.raw` owns the bucket's whole notification configuration. Anything else that writes it, such as the console, another stack, or turning on EventBridge notifications by hand, replaces it. The next `terraform plan` shows the change; apply to restore it.

## How the test stage works

`receiving_stage` (default `"test"`) picks the addresses the receipt rule accepts:

| Stage | Receipt rule accepts | Real mail to `lojo@` |
| --- | --- | --- |
| `test` | `lojo-test@cyberphysical.us` only (`receiving_test_local_part`) | Not accepted, as before the apply |
| `live` | `lojo@cyberphysical.us` and `dmarc@cyberphysical.us` | Stored and processed |

The apex MX already points at SES us-east-1, and no receipt rule set is active today, so mail to the domain is not stored today. The test stage keeps it that way for every address except the test one. Going live is a one-line change that updates the rule in place. It does not touch DNS, the bucket, or the key.

## 0. Before apply

- [ ] RUNBOOK sections 0 to 6 are done: tools, keys and SSM parameters, bundles built, and the pre-apply checklist passes.
- [ ] `terraform.tfvars` has `receiving_stage = "test"`, or leaves it out.
- [ ] `terraform plan` shows the receipt rule `store-raw` with `recipients = ["lojo-test@cyberphysical.us"]` and nothing else.
- [ ] `aws ses describe-active-receipt-rule-set --region us-east-1` still returns nothing.
- [ ] If the stack was applied before (the earlier test-stage deploy), the plan updates `aws_dynamodb_table.messages` **in place** to add the `vectors` global secondary index, and does not replace the table. DynamoDB builds the index online; the apply waits until it is `ACTIVE`, which takes seconds on a small table. `dynamodb:UpdateTable` is already in the apply policy. Any `must be replaced` on a table means stop.
- [ ] `embed_provider` is `"none"` (the default) for this first deploy, so nothing new is sent to a provider. Semantic search and assistants come after real mail works; see step 7.

Then `terraform apply`.

## 1. Read the outputs

```bash
cd infra/terraform
export AWS_REGION=us-east-1
BUCKET=$(terraform output -raw bucket)
KEY=$(terraform output -raw kms_key_arn)
MESSAGES=$(terraform output -json tables | jq -r .messages)
AUDIT=$(terraform output -json tables | jq -r .audit)
DLQ=$(terraform output -raw processor_dlq_url)
terraform output receiving   # stage "test", recipients ["lojo-test@cyberphysical.us"]
```

## 2. Check the wiring before sending anything

- [ ] The active rule set is `lojo-mail`, and its rule accepts the test address only. It requires TLS, scans for spam and viruses, and writes to `$BUCKET` under `raw/` with no SES-side `KmsKeyArn`:

  ```bash
  aws ses describe-active-receipt-rule-set \
    --query '{set:Metadata.Name, rules:Rules[].{recipients:Recipients,tls:TlsPolicy,scan:ScanEnabled,s3:Actions[0].S3Action}}'
  ```

- [ ] The bucket encrypts by default with the stack's key:

  ```bash
  aws s3api get-bucket-encryption --bucket "$BUCKET" \
    --query 'ServerSideEncryptionConfiguration.Rules[0]'
  # SSEAlgorithm aws:kms, KMSMasterKeyID == $KEY, BucketKeyEnabled true
  ```

- [ ] **SES could write into the encrypted bucket.** When the rule was created, SES wrote a setup object through the same path real mail will use. It must exist and be encrypted with the stack's key:

  ```bash
  aws s3api head-object --bucket "$BUCKET" --key raw/AMAZON_SES_SETUP_NOTIFICATION \
    --query '{sse:ServerSideEncryption, key:SSEKMSKeyId}'
  # sse "aws:kms", key == $KEY
  ```

  If it is missing, SES could not write, either because the bucket policy or the key policy refuses it. If it shows `AES256`, the rule was created before bucket encryption; this happened on the first test deploy from `cd429ce`. In either case, stop here. Fix the cause, delete the old object (`aws s3 rm "s3://$BUCKET/raw/AMAZON_SES_SETUP_NOTIFICATION"`), and run `terraform apply -replace=aws_ses_receipt_rule.store` so SES writes it again. Then repeat this check. The processor skips this object on purpose, and the `raw/` lifecycle removes it after `raw_retention_days`.

- [ ] New objects under `raw/` are wired to the processor, S3 is allowed to invoke it, and nothing throttles it:

  ```bash
  aws s3api get-bucket-notification-configuration --bucket "$BUCKET" \
    --query 'LambdaFunctionConfigurations[].{fn:LambdaFunctionArn,events:Events,filter:Filter}'
  # lojo-mail-processor, s3:ObjectCreated:*, prefix raw/ (an empty answer means no trigger)
  aws lambda get-policy --function-name lojo-mail-processor --query Policy --output text \
    | jq '.Statement[] | {sid:.Sid, principal:.Principal.Service, condition:.Condition}'
  # AllowS3Invoke: s3.amazonaws.com, SourceArn = the bucket, SourceAccount = this account
  # AllowRawSweep: events.amazonaws.com, SourceArn = rule lojo-mail-raw-sweep
  aws lambda get-function-concurrency --function-name lojo-mail-processor
  # {} (unreserved) or a number of at least 1; 0 would silently throttle every event
  aws events describe-rule --name lojo-mail-raw-sweep --query '{state:State,schedule:ScheduleExpression}'
  # ENABLED, rate(15 minutes)
  ```

- [ ] **Trigger test, without SES.** Put a small message under `raw/` by hand. It must be indexed with no manual invoke:

  ```bash
  printf 'From: trigger-test@example.com\r\nTo: lojo-test@cyberphysical.us\r\nSubject: trigger test %s\r\nMessage-ID: <trigger-%s@example.com>\r\n\r\nHand-placed object.\r\n' "$(date -u +%FT%TZ)" "$(date +%s)" > /tmp/trigger.eml
  aws s3 cp /tmp/trigger.eml "s3://$BUCKET/raw/trigger-test-$(date +%s)"
  sleep 30
  aws s3 ls "s3://$BUCKET/raw/"                 # the trigger-test object is gone
  aws logs tail /aws/lambda/lojo-mail-processor --since 5m   # one invocation, no error, no raw_swept
  ```

  If the object is still there after a minute, the notification is not working. Go to [If mail sits in raw/](#if-mail-sits-in-raw) before sending mail. The sweep would eventually pick it up, but the primary path must work first. Trash the test message in the web app afterwards. It has no DMARC pass, so it is flagged as unverified; that is expected.

- [ ] The dead-letter queue is empty, and no alarm is in `ALARM`:

  ```bash
  aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages
  aws cloudwatch describe-alarms --alarm-name-prefix lojo-mail- \
    --query 'MetricAlarms[].{name:AlarmName,state:StateValue}'
  ```

## 3. Send the test message

From an outside account (Gmail or similar, any provider that uses TLS), send to **`lojo-test@cyberphysical.us`**:

- a unique subject, for example `lojo live test 2026-10-01 14:05`;
- a body with a phrase you will search for later, for example `canary-7f3a`;
- optionally, one attachment over 4 MB. That tests presigned attachment downloads through the web app's CSP and the bucket's CORS.

Receiving does not need SES production access.

## 4. Follow it through each hop (allow about 2 minutes)

- [ ] **SES accepted it.** The sender gets no bounce. A bounce such as `550 mailbox unavailable` means the rule set is not active or the recipient does not match. Recheck step 2.
- [ ] **It was indexed automatically, with no manual invoke.** Do not run `aws lambda invoke` during this step. Within 2 minutes of sending, and before the 5-minute sweep threshold could apply, the processor log shows an invocation for the new `raw/` key, and there is no `raw_swept` line for it. The sweep alarm stays `OK`:

  ```bash
  aws logs filter-log-events --log-group-name /aws/lambda/lojo-mail-processor \
    --start-time $(( ($(date +%s) - 600) * 1000 )) --filter-pattern '"raw_swept"' --query 'events[].message'
  # []  (anything here means the notification missed it and the sweep caught it)
  aws cloudwatch describe-alarms --alarm-names lojo-mail-raw-swept --query 'MetricAlarms[0].StateValue'
  ```

- [ ] **The processor ran without errors:**

  ```bash
  aws logs tail /aws/lambda/lojo-mail-processor --since 10m
  # START / END / REPORT lines and no stack trace
  ```

- [ ] **It is indexed:** the newest inbox item is the test subject. It has a `bodyKey`, it has no body text, and its SPF, DKIM, and DMARC verdicts are `PASS` for a normal sender:

  ```bash
  aws dynamodb query --table-name "$MESSAGES" --index-name folder \
    --key-condition-expression 'folder = :f' --expression-attribute-values '{":f":{"S":"inbox"}}' \
    --no-scan-index-forward --max-items 1 \
    --query 'Items[0].{subject:subject.S,bodyKey:bodyKey.S,verdicts:verdicts}'
  ```

- [ ] **Raw MIME is gone:** `aws s3 ls "s3://$BUCKET/raw/"` lists only `AMAZON_SES_SETUP_NOTIFICATION`. The processor deletes each raw object after ingest.
- [ ] **The body is sealed:** the object at `bodyKey` is SSE-KMS with the stack's key, and its content is an envelope that does not contain the canary phrase:

  ```bash
  BODY_KEY=...   # bodyKey from the query above
  aws s3api head-object --bucket "$BUCKET" --key "$BODY_KEY" --query '{sse:ServerSideEncryption, key:SSEKMSKeyId}'
  aws s3 cp "s3://$BUCKET/$BODY_KEY" - | grep -c canary-7f3a   # 0
  ```

- [ ] **The AI step is recorded:** today's audit rows include `ai.analyze` with outcome `ok`, or an `ai.skip` with a reason you expect, such as `budget_exceeded` or no provider key:

  ```bash
  aws dynamodb query --table-name "$AUDIT" \
    --key-condition-expression '#d = :d' --expression-attribute-names '{"#d":"day"}' \
    --expression-attribute-values "{\":d\":{\"S\":\"$(date -u +%F)\"}}" \
    --query 'Items[].{action:action.S,outcome:outcome.S}'
  ```

- [ ] **Nothing failed:** the dead-letter queue still reports `0`, and `lojo-mail-processor-errors` is not in `ALARM`. Repeat the step 2 commands.
- [ ] **Jon can read it:** open the web app over HTTPS ([RUNBOOK.md](RUNBOOK.md#9-the-web-app)), sign in, load the envelope private key in Settings, and open the message. The text matches what you sent. If you attached a large file, download it.
- [ ] **Real mail is still untouched:** send one message to `lojo@cyberphysical.us`. It bounces, or is not delivered, just as before the apply. Nothing new appears under `raw/` or in the inbox.

If any box fails, stay in the test stage. [RUNBOOK.md](RUNBOOK.md#7-failed-messages-and-redrive) section 7 covers redrive, and section 8 covers turning receiving off.

## 5. Optional: outbound

If you plan to send from the web app on day one, send a reply to the test message from the web app now. In the SES sandbox, send only to a verified identity; see RUNBOOK section 4. Check the received copy for `dkim=pass`, and check that the copy appears in the web app under Sent.

## 6. Switch real mail on

Only when every box in step 4 is checked:

```bash
# terraform.tfvars
receiving_stage = "live"
```

```bash
terraform plan    # exactly one change: aws_ses_receipt_rule.store, recipients updated in place
terraform apply
terraform output receiving   # stage "live", recipients lojo@ and dmarc@
```

Then send one more message from outside, this time to `lojo@cyberphysical.us`. Repeat the step 4 checks for indexed, raw gone, and sealed. After that, mail to the real address is live. Mail to `lojo-test@` is no longer accepted.

To go back, set `receiving_stage = "test"` and apply. Real mail then stops being accepted again, and nothing already stored is touched. To stop all receiving, follow RUNBOOK section 8.

## 7. Optional: assistants and semantic search

None of this is needed for mail to work. Do it after step 6, one piece at a time. [INTEGRATIONS.md](INTEGRATIONS.md) has the details.

**Agent tokens for Cursor, Grok, and local models.** Create `/lojo-mail/agent-tokens` ([INTEGRATIONS.md](INTEGRATIONS.md#tokens-one-per-client)), then wait 5 minutes for the API to reload it, or force a cold start:

```bash
aws lambda update-function-configuration --function-name lojo-mail-api --description "agent tokens $(date +%s)"
API=$(terraform output -raw api_endpoint)
curl -s "$API/v1/session" -H "Authorization: Bearer $LOJO_CURSOR_TOKEN"
# {"kind":"token","label":"agent:cursor","scopes":["read"]}
```

If every agent token gets `401`, the list was refused as a whole. The log says which entry is wrong (a `send` or `admin` scope, a short token, a duplicate label): `aws logs tail /aws/lambda/lojo-mail-api --since 10m --filter-pattern agent_tokens_invalid`. The web app is unaffected.

- [ ] **Remote MCP answers, with the token's scopes only:**

  ```bash
  curl -s "$API/mcp" -H "Authorization: Bearer $LOJO_GROK_TOKEN" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '[.result.tools[].name]'
  # a read token: ["search_mail","read_thread","list_inbox","export_mailbox"]; never a send tool
  ```

- [ ] **It refuses what it should:** the same call without the header gets `401`; with a web session token (`hs_…`) it gets `403`; `curl -X GET "$API/mcp"` gets `405`.
- [ ] **It is traced:** `aws logs tail /aws/lambda/lojo-mail-api --since 10m --filter-pattern api_request` shows `agent:grok` lines.

**Semantic search.** Pick a provider (Bedrock Titan stays inside the account and costs cents a month; see [COSTS_COMPARE.md](COSTS_COMPARE.md)), enable model access for `amazon.titan-embed-text-v2:0` in the Bedrock console, then:

```bash
# terraform.tfvars
embed_provider = "bedrock"
```

```bash
terraform plan    # Lambda environment (LOJO_EMBED_PROVIDER) and the roles' Bedrock statement change; nothing else
terraform apply
```

- [ ] Send one message to the live address. Its item gets `vecModel = "bedrock/amazon.titan-embed-text-v2:0@256"`, and the audit table has an `ai.embed` row with outcome `ok`:

  ```bash
  aws dynamodb query --table-name "$MESSAGES" --index-name vectors \
    --key-condition-expression "vecModel = :m" --expression-attribute-values '{":m":{"S":"bedrock/amazon.titan-embed-text-v2:0@256"}}' \
    --select COUNT
  ```

- [ ] Backfill recent mail with a token that has `write` and `body` (`npm run local -- backfill --limit 50`, repeated until `remaining` is 0), then search in the web app with Search → Semantic.
- [ ] An `ai.embed` row with outcome `error` means the role cannot call the model: check model access in the Bedrock console and the `bedrock:InvokeModel` statement on `lojo-mail-processor`'s role.

To turn semantic search off again, set `embed_provider = "none"` and apply. Stored vectors stay until they are cleared; see [SECURITY.md](SECURITY.md#residual-risks).

**Mail rules.** Rules work without any Terraform change: save them from your session ([RUNBOOK.md](RUNBOOK.md#mail-rules)). Only auto-send needs the flag:

```bash
# terraform.tfvars, only when a rule really needs to answer without you
auto_send_enabled = true
```

```bash
terraform plan    # the processor role gains RuleAutoSendAsMailbox; LOJO_AUTO_SEND becomes "on"; nothing else
terraform apply
```

- [ ] With the flag off, a message that matches an auto-send rule leaves a draft under Drafts → "Waiting for your approval" and an audit row `rule.reply` / `autosend_refused` naming `auto-send is disabled on this deployment`.
- [ ] With the flag on, a message from an allowlisted sender with DMARC pass gets one reply with `Auto-Submitted: auto-replied`, and the audit table has `rule.autosend` / `sent`. A second message from the same sender that day becomes a draft (`per-sender daily limit`).

**Thunderbird.** Create the bridge token (`/lojo-mail/bridge-token`, [RUNBOOK.md](RUNBOOK.md#1-keys-and-parameters)), wait 5 minutes for the API to reload, then follow [THUNDERBIRD.md](THUNDERBIRD.md) on Santa Computa. `curl -s "$API/v1/session" -H "Authorization: Bearer $BRIDGE_TOKEN"` must show `{"kind":"token","label":"bridge","scopes":["read","write","body","compose","trash"]}`. `trash` is there because `bridge_trash_enabled` defaults to `true`: deleting in Thunderbird moves mail to Trash. Set it to `false` and the scope disappears; delete then archives with a hidden label.

**Trash purge.** `trash_purge_mode` defaults to `report`: the `lojo-mail-trash-purge` Lambda runs daily and only audits what it would delete (`trash.purge_report`). Nothing is hard deleted until you set `trash_purge_mode = "purge"` and apply; the plan then shows only the purge role gaining `PurgeExpiredTrash` and `DeletePurgedObjects` and `LOJO_TRASH_PURGE` changing. `off` disables the schedule. See [RUNBOOK.md](RUNBOOK.md#trash-purge).

## If mail sits in raw/

The sweep ingests anything older than 5 minutes on its next run, and the `lojo-mail-raw-swept` alarm says the primary trigger missed it. Find out why:

1. **Is the notification there?** `aws s3api get-bucket-notification-configuration --bucket "$BUCKET"`. If the answer is empty or has no `LambdaFunctionConfigurations`, it was never created or something overwrote it. CloudTrail shows who: search `PutBucketNotificationConfiguration` on the bucket. Run a full `terraform apply` (not `-target`) to restore it.
2. **Did S3 send the event?** Check the processor's `AsyncEventsReceived` metric for the last hour:

   ```bash
   aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name AsyncEventsReceived \
     --dimensions Name=FunctionName,Value=lojo-mail-processor --statistics Sum --period 300 \
     --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)"
   # GNU date; on macOS use: date -u -v-1H +%FT%TZ
   ```

   Zero means S3 did not invoke: see steps 1 and 3. A non-zero value with no log lines means Lambda received the event but did not run it. Check `get-function-concurrency`: 0 throttles everything, and the variable now refuses 0. Also check `AsyncEventsDropped`, and the DLQ.
3. **May S3 invoke it?** `aws lambda get-policy --function-name lojo-mail-processor` must have `AllowS3Invoke` with the bucket ARN and this account. If it is missing, apply again.
4. **Did it run and fail?** Errors in `aws logs tail /aws/lambda/lojo-mail-processor --since 1h`, and messages in the DLQ, mean the trigger works and ingest failed. See RUNBOOK section 7.

To drain `raw/` now rather than wait for the schedule, run the sweep by hand. It still skips objects younger than 5 minutes:

```bash
aws lambda invoke --function-name lojo-mail-processor \
  --cli-binary-format raw-in-base64-out --payload '{"lojo":"sweep-raw"}' /tmp/sweep.json && cat /tmp/sweep.json
# {"processed": N, "skipped": M}, where skipped counts objects deferred to the next run
```

Nothing in `raw/` is lost while you investigate. The lifecycle keeps it for `raw_retention_days` (7).

