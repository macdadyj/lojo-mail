# Offline plan checks for infra/terraform. No AWS credentials, no API calls:
# every provider is mocked. `npm run infra:validate` runs them.
#
# Assertions encode what docs/SECURITY.md, docs/ARCHITECTURE.md and
# docs/RUNBOOK.md promise. Started as the QA review's harness
# (qa/REVIEW_REPORT.md); the finding runs now assert the fix.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_data "aws_sesv2_email_identity" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:111122223333:identity/cyberphysical.us"
      dkim_signing_attributes = [{
        tokens                        = ["tok1", "tok2", "tok3"]
        status                        = "SUCCESS"
        signing_attributes_origin     = "AWS_SES"
        current_signing_key_length    = "RSA_2048_BIT"
        next_signing_key_length       = "RSA_2048_BIT"
        last_key_generation_timestamp = ""
        domain_signing_private_key    = ""
        domain_signing_selector       = ""
      }]
    }
  }

  mock_resource "aws_sesv2_email_identity" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:111122223333:identity/lojo.dev"
      dkim_signing_attributes = {
        tokens                        = ["new1", "new2", "new3"]
        status                        = "PENDING"
        signing_attributes_origin     = "AWS_SES"
        current_signing_key_length    = "RSA_2048_BIT"
        next_signing_key_length       = "RSA_2048_BIT"
        last_key_generation_timestamp = ""
        domain_signing_private_key    = ""
        domain_signing_selector       = ""
      }
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn    = "arn:aws:s3:::lojo-mail-test"
      bucket = "lojo-mail-test"
    }
  }

  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn = "arn:aws:dynamodb:us-east-1:111122223333:table/lojo-mail-test"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:111122223333:log-group:/aws/lambda/lojo-mail"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/lojo-mail"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:us-east-1:111122223333:function:lojo-mail"
      invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:111122223333:function:lojo-mail/invocations"
    }
  }

  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:us-east-1:111122223333:abc123"
      api_endpoint  = "https://abc123.execute-api.us-east-1.amazonaws.com"
    }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-1:111122223333:lojo-mail-processor-dlq"
      url = "https://sqs.us-east-1.amazonaws.com/111122223333/lojo-mail-processor-dlq"
    }
  }

  mock_resource "aws_sesv2_configuration_set" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:111122223333:configuration-set/lojo-mail"
    }
  }
}

mock_provider "archive" {}

override_resource {
  target = aws_dynamodb_table.messages
  values = { arn = "arn:aws:dynamodb:us-east-1:111122223333:table/lojo-mail-messages" }
}

override_resource {
  target = aws_dynamodb_table.threads
  values = { arn = "arn:aws:dynamodb:us-east-1:111122223333:table/lojo-mail-threads" }
}

override_resource {
  target = aws_dynamodb_table.drafts
  values = { arn = "arn:aws:dynamodb:us-east-1:111122223333:table/lojo-mail-drafts" }
}

override_resource {
  target = aws_dynamodb_table.audit
  values = { arn = "arn:aws:dynamodb:us-east-1:111122223333:table/lojo-mail-audit" }
}

override_resource {
  target = aws_dynamodb_table.contacts
  values = { arn = "arn:aws:dynamodb:us-east-1:111122223333:table/lojo-mail-contacts" }
}

override_resource {
  target = aws_cloudwatch_event_rule.raw_sweep
  values = { arn = "arn:aws:events:us-east-1:111122223333:rule/lojo-mail-raw-sweep" }
}

override_resource {
  target = aws_dynamodb_table.budget
  values = { arn = "arn:aws:dynamodb:us-east-1:111122223333:table/lojo-mail-budget" }
}

# ---------------------------------------------------------------------------
# 1. Default variables (the documented first apply).
# ---------------------------------------------------------------------------
run "defaults_adopt_existing_identity_and_write_no_dns" {
  command = plan

  assert {
    condition     = length(data.aws_sesv2_email_identity.existing) == 1
    error_message = "existing mode must read the SES identity"
  }

  assert {
    condition     = length(aws_sesv2_email_identity.created) == 0 && length(aws_sesv2_email_identity_mail_from_attributes.created) == 0
    error_message = "existing mode must not create an SES identity or MAIL FROM attributes"
  }

  assert {
    condition = sum([
      length(aws_route53_record.dkim),
      length(aws_route53_record.mx_inbound),
      length(aws_route53_record.mail_from_mx),
      length(aws_route53_record.mail_from_spf),
      length(aws_route53_record.apex_spf),
      length(aws_route53_record.dmarc),
    ]) == 0
    error_message = "default plan must create zero Route 53 records"
  }

  assert {
    condition     = length(terraform_data.dns_guard) == 0
    error_message = "dns guard should be inert when manage_dns is false"
  }

  assert {
    condition     = aws_ses_receipt_rule.store.tls_policy == "Require" && aws_ses_receipt_rule.store.scan_enabled
    error_message = "receipt rule must require TLS and scan"
  }

  assert {
    condition     = toset(aws_ses_receipt_rule.store.recipients) == toset(["lojo-test@cyberphysical.us"])
    error_message = "a first deploy (receiving_stage = test) must accept only the test address, never real mail"
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.mail.block_public_acls,
      aws_s3_bucket_public_access_block.mail.block_public_policy,
      aws_s3_bucket_public_access_block.mail.ignore_public_acls,
      aws_s3_bucket_public_access_block.mail.restrict_public_buckets,
    ])
    error_message = "all four S3 public access blocks must be on"
  }

  assert {
    condition     = aws_kms_key.mail.enable_key_rotation
    error_message = "KMS rotation must be on"
  }

  assert {
    condition     = one(aws_sesv2_configuration_set.outbound.delivery_options).tls_policy == "REQUIRE"
    error_message = "outbound TLS must be REQUIRE"
  }
}

# SECURITY.md > IAM: receipt rule set activation defaults on.
run "active_rule_set_defaults_on_as_security_md_says" {
  command = plan

  assert {
    condition     = length(aws_ses_active_receipt_rule_set.main) == 1
    error_message = "manage_active_rule_set should default to true"
  }

  assert {
    condition     = strcontains(file("${path.module}/../../docs/SECURITY.md"), "Receipt rule set activation defaults ON")
    error_message = "SECURITY.md must say that manage_active_rule_set defaults on"
  }
}

run "live_stage_accepts_the_mailbox_and_dmarc_only" {
  command = plan

  variables {
    receiving_stage = "live"
  }

  assert {
    condition     = toset(aws_ses_receipt_rule.store.recipients) == toset(["lojo@cyberphysical.us", "dmarc@cyberphysical.us"])
    error_message = "receipt rule must name only lojo@ and dmarc@ once live"
  }

  assert {
    condition     = aws_ses_receipt_rule.store.tls_policy == "Require" && aws_ses_receipt_rule.store.scan_enabled
    error_message = "going live must not change TLS or scanning"
  }
}

run "test_address_cannot_be_the_mailbox" {
  command = plan

  variables {
    receiving_test_local_part = "lojo"
  }

  expect_failures = [var.receiving_test_local_part]
}

# ---------------------------------------------------------------------------
# 2. Least privilege and functional IAM. The store (packages/core/src/store/
# dynamo.ts) uses GetItem, PutItem, UpdateItem, and Query on tables and GSIs.
# ---------------------------------------------------------------------------
# ARNs are only known after apply; apply runs against the mock provider only.
run "roles_query_the_indexes_and_never_scan_or_delete" {
  command = apply

  assert {
    condition = alltrue([
      for doc in [data.aws_iam_policy_document.processor, data.aws_iam_policy_document.api] :
      contains(flatten([for s in doc.statement : s.actions]), "dynamodb:Query")
    ])
    error_message = "both roles need dynamodb:Query"
  }

  assert {
    condition = alltrue([
      for doc in [data.aws_iam_policy_document.processor, data.aws_iam_policy_document.api] :
      length(setintersection(toset(flatten([for s in doc.statement : s.actions])), toset(["dynamodb:Scan", "dynamodb:DeleteItem", "dynamodb:*"]))) == 0
    ])
    error_message = "no role may Scan or DeleteItem"
  }

  assert {
    condition     = length([for s in data.aws_iam_policy_document.processor.statement : s if s.sid == "IndexTables" && length([for r in s.resources : r if endswith(r, "/index/*")]) == 6]) == 1
    error_message = "the processor must be able to Query every table's indexes"
  }

  assert {
    condition = alltrue([
      for doc in [data.aws_iam_policy_document.processor, data.aws_iam_policy_document.api] :
      alltrue([for s in doc.statement : !contains(s.resources, "*")])
    ])
    error_message = "no statement may use Resource *"
  }
}

run "tables_have_the_indexes_the_store_queries" {
  command = plan

  assert {
    condition     = toset([for i in aws_dynamodb_table.messages.global_secondary_index : i.name]) == toset(["folder", "thread", "rfc", "vectors"])
    error_message = "messages needs folder, thread, rfc, and vectors GSIs"
  }

  assert {
    condition = one([
      for i in aws_dynamodb_table.messages.global_secondary_index : i
      if i.name == "vectors" && i.hash_key == "vecModel" && i.projection_type == "INCLUDE" && toset(i.non_key_attributes) == toset(["vec"])
    ]) != null
    error_message = "the vectors GSI must be keyed on vecModel and project only vec, matching TABLE_SCHEMAS"
  }

  assert {
    condition = alltrue([
      one(aws_dynamodb_table.threads.global_secondary_index).name == "recent",
      one(aws_dynamodb_table.drafts.global_secondary_index).name == "recent",
      one(aws_dynamodb_table.contacts.global_secondary_index).name == "all",
    ])
    error_message = "threads, drafts, and contacts need their listing GSIs"
  }

  assert {
    condition = alltrue([
      for t in [
        aws_dynamodb_table.messages, aws_dynamodb_table.threads, aws_dynamodb_table.drafts,
        aws_dynamodb_table.audit, aws_dynamodb_table.contacts, aws_dynamodb_table.budget,
      ] : t.deletion_protection_enabled
    ])
    error_message = "every table needs deletion protection"
  }
}

run "server_seal_kms_use_is_bound_to_its_purpose" {
  command = plan

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.processor.statement :
      anytrue([for c in s.condition : c.variable == "kms:ViaService" || c.variable == "kms:EncryptionContext:purpose"])
      if length([for a in s.actions : a if startswith(a, "kms:")]) > 0
    ])
    error_message = "every processor KMS grant must be limited by ViaService or encryption-context purpose"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.api.statement :
      anytrue([for c in s.condition : c.variable == "kms:ViaService" || c.variable == "kms:EncryptionContext:purpose"])
      if length([for a in s.actions : a if startswith(a, "kms:")]) > 0
    ])
    error_message = "every API KMS grant must be limited by ViaService or encryption-context purpose"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.processor.statement :
      alltrue([for c in s.condition : c.values == tolist(["rules"]) if c.variable == "kms:EncryptionContext:purpose"])
      if contains(s.actions, "kms:Decrypt") && anytrue([for c in s.condition : c.variable == "kms:EncryptionContext:purpose"])
    ])
    error_message = "the processor seals AI-context and draft copies but must not open them; it may only open the rules"
  }
}

run "rules_are_sealed_by_the_api_and_only_opened_by_the_processor" {
  command = plan

  assert {
    condition = !contains(flatten([
      for s in data.aws_iam_policy_document.processor.statement : s.actions
      if anytrue([for c in s.condition : c.variable == "kms:EncryptionContext:purpose" && contains(c.values, "rules")])
    ]), "kms:GenerateDataKey")
    error_message = "the processor must not be able to produce a sealed rules document"
  }

  assert {
    condition = contains(flatten([
      for s in data.aws_iam_policy_document.api.statement : s.actions
      if anytrue([for c in s.condition : c.variable == "kms:EncryptionContext:purpose" && contains(c.values, "rules")])
    ]), "kms:GenerateDataKey")
    error_message = "the API seals the rules Jon saves"
  }

  assert {
    condition     = length([for r in flatten([for s in data.aws_iam_policy_document.processor.statement : s.resources if contains(s.actions, "s3:PutObject")]) : r if endswith(r, "/rules/*")]) == 0
    error_message = "the processor never writes rules"
  }
}

run "auto_send_is_off_by_default" {
  command = plan

  assert {
    condition     = aws_lambda_function.processor.environment[0].variables.LOJO_AUTO_SEND == "off"
    error_message = "rules must not auto-send unless auto_send_enabled is set"
  }

  assert {
    condition     = length(setintersection(toset(flatten([for s in data.aws_iam_policy_document.processor.statement : s.actions])), toset(["ses:SendEmail", "ses:SendRawEmail"]))) == 0
    error_message = "the processor has no SES send permission by default"
  }
}

run "auto_send_flag_grants_the_processor_ses_as_the_mailbox_only" {
  command = plan

  variables {
    auto_send_enabled = true
  }

  assert {
    condition     = aws_lambda_function.processor.environment[0].variables.LOJO_AUTO_SEND == "on"
    error_message = "the flag turns auto-send on"
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.processor.statement : s
      if s.sid == "RuleAutoSendAsMailbox" && anytrue([for c in s.condition : c.variable == "ses:FromAddress" && c.values == tolist(["lojo@cyberphysical.us"])])
    ]) == 1
    error_message = "auto-send may only send as the mailbox"
  }
}

run "the_api_reads_the_bridge_token" {
  command = plan

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.api.statement : s.resources if s.sid == "ReadConfig"]), "arn:aws:ssm:us-east-1:111122223333:parameter/lojo-mail/bridge-token")
    error_message = "the API reads the bridge token"
  }

  assert {
    condition     = !contains(flatten([for s in data.aws_iam_policy_document.processor.statement : s.resources]), "arn:aws:ssm:us-east-1:111122223333:parameter/lojo-mail/bridge-token")
    error_message = "the processor never needs the bridge token"
  }
}

run "ses_can_only_use_the_key_for_this_receipt_rule_set" {
  command = plan

  assert {
    condition = alltrue([
      for st in jsondecode(aws_kms_key.mail.policy).Statement : (
        toset(st.Action) == toset(["kms:GenerateDataKey*", "kms:Encrypt", "kms:Decrypt"]) &&
        st.Condition.StringLike["aws:SourceArn"] == "arn:aws:ses:us-east-1:111122223333:receipt-rule-set/lojo-mail:receipt-rule/*" &&
        st.Condition.StringEquals["aws:SourceAccount"] == "111122223333"
      ) if st.Sid == "SesUseOfKey"
    ])
    error_message = "the SES key grant must be data-key only and scoped to this rule set"
  }
}

# SES S3 action with kms_key_arn uses the S3 *client-side* encryption client,
# and handler.ts reads with plain GetObject. The bucket's SSE-KMS covers raw/.
# command = apply against the mock provider only; nothing leaves this machine.
run "receipt_rule_relies_on_bucket_sse_kms_not_ses_client_side_encryption" {
  command = apply

  assert {
    condition     = one(aws_ses_receipt_rule.store.s3_action).kms_key_arn == null || one(aws_ses_receipt_rule.store.s3_action).kms_key_arn == ""
    error_message = "s3_action.kms_key_arn must be unset: SES would encrypt client-side and the processor would parse ciphertext"
  }
}

run "lambda_runtime_is_supported" {
  command = plan

  assert {
    condition     = aws_lambda_function.processor.runtime == "nodejs22.x" && aws_lambda_function.api.runtime == "nodejs22.x"
    error_message = "both functions should run nodejs22.x"
  }
}

run "processor_has_failure_destination_or_dlq" {
  command = plan

  assert {
    condition     = length(aws_lambda_function.processor.dead_letter_config) > 0
    error_message = "processor needs a DLQ"
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.processor.maximum_retry_attempts == 2
    error_message = "processor should retry twice before the DLQ"
  }

  assert {
    condition     = aws_sqs_queue.processor_dlq.sqs_managed_sse_enabled
    error_message = "the DLQ holds object keys and must be encrypted"
  }

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.processor.statement : s.actions]), "sqs:SendMessage")
    error_message = "the processor role must be able to write to its DLQ"
  }
}

run "raw_mime_and_ai_context_expire" {
  command = plan

  assert {
    condition = anytrue([
      for r in aws_s3_bucket_lifecycle_configuration.mail.rule :
      r.id == "raw-retention" && try(r.expiration[0].days, 0) == 7 && try(r.noncurrent_version_expiration[0].noncurrent_days, 0) == 1
    ])
    error_message = "raw/ should expire after 7 days and its noncurrent versions after 1"
  }

  assert {
    condition     = anytrue([for r in aws_s3_bucket_lifecycle_configuration.mail.rule : r.id == "ai-context-retention" && try(r.expiration[0].days, 0) == 30])
    error_message = "ai-context/ should expire after 30 days by default"
  }

  assert {
    condition     = aws_lambda_function.processor.environment[0].variables.LOJO_DELETE_RAW == "1"
    error_message = "the processor should delete raw/ after indexing"
  }
}

run "ai_context_days_zero_disables_the_copy" {
  command = plan

  variables {
    ai_context_days = 0
  }

  assert {
    condition     = !anytrue([for r in aws_s3_bucket_lifecycle_configuration.mail.rule : r.id == "ai-context-retention"])
    error_message = "no ai-context rule when the copy is disabled"
  }

  assert {
    condition     = aws_lambda_function.processor.environment[0].variables.LOJO_AI_CONTEXT_DAYS == "0"
    error_message = "the processor must be told not to write AI-context copies"
  }
}

run "bedrock_grant_only_with_bedrock_provider" {
  command = plan

  assert {
    condition     = !contains(flatten([for s in data.aws_iam_policy_document.processor.statement : s.actions]), "bedrock:InvokeModel")
    error_message = "no Bedrock grant for the default provider"
  }
}

run "bedrock_provider_can_invoke_its_model" {
  command = plan

  variables {
    llm_provider = "bedrock"
  }

  assert {
    condition = alltrue([
      for doc in [data.aws_iam_policy_document.processor, data.aws_iam_policy_document.api] :
      contains(flatten([for s in doc.statement : s.resources if s.sid == "Bedrock"]), "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0")
    ])
    error_message = "both roles need bedrock:InvokeModel on the foundation model behind the inference profile"
  }
}

run "bedrock_embeddings_grant_only_the_titan_model" {
  command = plan

  variables {
    embed_provider = "bedrock"
  }

  assert {
    condition = alltrue([
      for doc in [data.aws_iam_policy_document.processor, data.aws_iam_policy_document.api] :
      toset(flatten([for s in doc.statement : s.resources if s.sid == "Bedrock"])) == toset(["arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0"])
    ])
    error_message = "embeddings on Bedrock grant InvokeModel on the Titan model only, not the chat model"
  }

  assert {
    condition     = aws_lambda_function.processor.environment[0].variables.LOJO_EMBED_PROVIDER == "bedrock" && aws_lambda_function.api.environment[0].variables.LOJO_EMBED_PROVIDER == "bedrock"
    error_message = "both Lambdas must use the same embedder, or queries and stored vectors will not match"
  }
}

run "embeddings_are_off_by_default" {
  command = plan

  assert {
    condition     = aws_lambda_function.processor.environment[0].variables.LOJO_EMBED_PROVIDER == "none"
    error_message = "the next apply must not start paying for embeddings unless embed_provider is set"
  }
}

run "provider_keys_and_agent_tokens_are_readable_only_where_needed" {
  command = plan

  assert {
    condition = alltrue([
      for name in ["grok-api-key", "openai-api-key", "gemini-api-key", "vertex-sa-json"] :
      contains(flatten([for s in data.aws_iam_policy_document.processor.statement : s.resources if s.sid == "ReadConfig"]), "arn:aws:ssm:us-east-1:111122223333:parameter/lojo-mail/${name}")
    ])
    error_message = "the processor reads the selected provider's key"
  }

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.api.statement : s.resources if s.sid == "ReadConfig"]), "arn:aws:ssm:us-east-1:111122223333:parameter/lojo-mail/agent-tokens")
    error_message = "the API reads the agent token list"
  }

  assert {
    condition     = !contains(flatten([for s in data.aws_iam_policy_document.processor.statement : s.resources]), "arn:aws:ssm:us-east-1:111122223333:parameter/lojo-mail/agent-tokens")
    error_message = "the processor never needs API tokens"
  }
}

run "unknown_embed_provider_is_refused" {
  command = plan

  variables {
    embed_provider = "opensearch"
  }

  expect_failures = [var.embed_provider]
}

run "api_stage_is_throttled" {
  command = plan

  assert {
    condition     = one(aws_apigatewayv2_stage.default.default_route_settings).throttling_rate_limit == 10
    error_message = "the API stage needs a rate limit"
  }
}

# ---------------------------------------------------------------------------
# 3. DNS guard rails.
# ---------------------------------------------------------------------------
run "manage_dns_is_refused_in_existing_mode" {
  command = plan

  variables {
    manage_dns               = true
    dns_cutover_confirmation = "I-audited-the-existing-zone"
    zone_id                  = "Z0000000000000"
  }

  expect_failures = [terraform_data.dns_guard]
}

run "create_mode_without_confirmation_is_refused" {
  command = plan

  variables {
    domain            = "lojo.dev"
    ses_identity_mode = "create"
    manage_dns        = true
    zone_id           = "Z0000000000000"
  }

  expect_failures = [terraform_data.dns_guard]
}

run "create_mode_without_zone_is_refused" {
  command = plan

  variables {
    domain                   = "lojo.dev"
    ses_identity_mode        = "create"
    manage_dns               = true
    dns_cutover_confirmation = "I-audited-the-existing-zone"
  }

  expect_failures = [terraform_data.dns_guard]
}

run "dns_plan_output_lists_every_record_to_leave_alone" {
  command = plan

  assert {
    condition = alltrue([
      for needle in ["NS and SOA", "ACM validation", "_domainkey", "_amazonses", "mail.cyberphysical.us MX", "Apex SPF", "Apex MX"] :
      anytrue([for line in output.dns_plan.leave_untouched : strcontains(line, needle)])
    ])
    error_message = "dns_plan.leave_untouched is missing one of the audited records"
  }

  assert {
    condition     = output.dns_plan.applied_by_terraform == "none — suggestions below are not Route 53 resources"
    error_message = "existing mode must apply no DNS"
  }
}

# In create mode dkim_signing_attributes carries the sensitive
# domain_signing_private_key; the dkim_tokens output must still plan.
run "create_mode_with_confirmation_writes_new_domain_records_without_overwrite" {
  command = apply

  variables {
    domain                   = "lojo.dev"
    ses_identity_mode        = "create"
    manage_dns               = true
    dns_cutover_confirmation = "I-audited-the-existing-zone"
    zone_id                  = "Z0000000000000"
  }

  assert {
    condition     = length(aws_route53_record.dkim) == 3 && length(aws_route53_record.apex_spf) == 1
    error_message = "create mode should plan the new identity's records"
  }

  # allow_overwrite is not set anywhere in dns.tf (checked by grep in the
  # report), so the provider default (false) applies: an existing record makes
  # apply fail instead of being replaced. Mocked values stay unknown here.
  assert {
    condition     = toset(aws_route53_record.mx_inbound[0].records) == toset(["10 inbound-smtp.us-east-1.amazonaws.com"])
    error_message = "new-domain MX should target the SES inbound endpoint in the configured region"
  }

  assert {
    condition     = length(output.dkim_tokens) == 3
    error_message = "dkim_tokens output should plan in create mode"
  }
}

run "sign_in_is_throttled_per_source_and_alarms_globally" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.budget.ttl[0].enabled && aws_dynamodb_table.budget.ttl[0].attribute_name == "expiresAt"
    error_message = "login-failure counters in the budget table need the expiresAt TTL"
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.login_failures.pattern == "\"login_failed\""
    error_message = "the login-failure metric filter must match the API's login_failed log line"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.login_failures.threshold == 20 && aws_cloudwatch_metric_alarm.login_failures.period == 3600
    error_message = "the login-failure alarm should default to 20 failures per hour"
  }
}

run "web_blob_origin_is_the_exact_presigned_url_origin" {
  command = plan

  assert {
    condition     = output.web_blob_origin == "https://lojo-mail-test.s3.us-east-1.amazonaws.com"
    error_message = "web_blob_origin must be the one bucket origin presigned URLs use, for the web CSP"
  }
}

run "raw_objects_reach_the_processor_by_notification_and_by_sweep" {
  command = plan

  assert {
    condition = alltrue([
      length(aws_s3_bucket_notification.raw.lambda_function) == 1,
      aws_s3_bucket_notification.raw.lambda_function[0].filter_prefix == "raw/",
      contains(aws_s3_bucket_notification.raw.lambda_function[0].events, "s3:ObjectCreated:*"),
    ])
    error_message = "every ObjectCreated under raw/ must notify the processor"
  }

  assert {
    condition = alltrue([
      aws_lambda_permission.s3_invoke.principal == "s3.amazonaws.com",
      aws_lambda_permission.s3_invoke.source_account == "111122223333",
      aws_lambda_permission.s3_invoke.action == "lambda:InvokeFunction",
    ])
    error_message = "S3 may invoke the processor only from this account and bucket"
  }

  assert {
    condition     = aws_cloudwatch_event_rule.raw_sweep.schedule_expression == "rate(15 minutes)"
    error_message = "the raw/ sweep should run every 15 minutes by default"
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_target.raw_sweep.input).lojo == "sweep-raw"
    error_message = "the sweep target input must match SWEEP_EVENT in packages/pipeline/src/raw.ts"
  }

  assert {
    condition     = aws_lambda_permission.raw_sweep.principal == "events.amazonaws.com" && aws_lambda_permission.raw_sweep.source_account == "111122223333"
    error_message = "only this account's sweep rule may invoke the processor"
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.raw_swept.pattern == "\"raw_swept\"" && aws_cloudwatch_metric_alarm.raw_swept.threshold == 0
    error_message = "any swept message must raise the raw-swept alarm"
  }
}

run "sweep_every_minute_uses_singular_rate" {
  command = plan

  variables {
    raw_sweep_minutes = 1
  }

  assert {
    condition     = aws_cloudwatch_event_rule.raw_sweep.schedule_expression == "rate(1 minute)"
    error_message = "EventBridge needs rate(1 minute), not rate(1 minutes)"
  }
}

run "zero_reserved_concurrency_is_refused" {
  command = plan

  variables {
    processor_reserved_concurrency = 0
  }

  expect_failures = [var.processor_reserved_concurrency]
}
