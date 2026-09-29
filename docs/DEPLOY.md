# First deploy: live test before real mail

This is the go/no-go check for the first `terraform apply`. It proves, with one test message to a test address, that SES can write into the KMS-encrypted bucket and that the processor picks the message up, seals it, and indexes it. Real mail to `lojo@cyberphysical.us` stays untouched until the last step.

Nothing in this repo has been applied. Run this as the apply principal from [RUNBOOK.md](RUNBOOK.md#who-can-apply), in us-east-1.

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

  If it is missing, SES could not write, either because the bucket policy or the key policy refuses it. Stop here. Fix it, then run `terraform apply -replace=aws_ses_receipt_rule.store` so SES writes the setup object again. The processor skips this object on purpose, and the `raw/` lifecycle removes it after `raw_retention_days`.

- [ ] New objects under `raw/` trigger the processor:

  ```bash
  aws s3api get-bucket-notification-configuration --bucket "$BUCKET" \
    --query 'LambdaFunctionConfigurations[].{fn:LambdaFunctionArn,events:Events,filter:Filter}'
  # lojo-mail-processor, s3:ObjectCreated:*, prefix raw/
  ```

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
