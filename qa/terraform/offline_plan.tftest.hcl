# Offline plan checks for infra/terraform. No AWS credentials, no API calls:
# every provider is mocked. Run from the repo root:
#
#   terraform -chdir=infra/terraform init -backend=false
#   terraform -chdir=infra/terraform test -test-directory=../../qa/terraform
#
# Assertions encode what docs/SECURITY.md, docs/ARCHITECTURE.md and
# docs/RUNBOOK.md promise. A failing assertion is a review finding.

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
        tokens                     = ["tok1", "tok2", "tok3"]
        status                     = "SUCCESS"
        signing_attributes_origin  = "AWS_SES"
        current_signing_key_length = "RSA_2048_BIT"
        next_signing_key_length    = "RSA_2048_BIT"
        last_key_generation_timestamp = ""
        domain_signing_private_key = ""
        domain_signing_selector    = ""
      }]
    }
  }

  mock_resource "aws_sesv2_email_identity" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:111122223333:identity/lojo.dev"
      dkim_signing_attributes = {
        tokens                     = ["new1", "new2", "new3"]
        status                     = "PENDING"
        signing_attributes_origin  = "AWS_SES"
        current_signing_key_length = "RSA_2048_BIT"
        next_signing_key_length    = "RSA_2048_BIT"
        last_key_generation_timestamp = ""
        domain_signing_private_key = ""
        domain_signing_selector    = ""
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

  mock_resource "aws_sesv2_configuration_set" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:111122223333:configuration-set/lojo-mail"
    }
  }
}

mock_provider "archive" {}

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
    condition     = toset(aws_ses_receipt_rule.store.recipients) == toset(["lojo@cyberphysical.us", "dmarc@cyberphysical.us"])
    error_message = "receipt rule must name only lojo@ and dmarc@"
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

# SECURITY.md > IAM: "Receipt rule set activation is a Terraform flag
# defaulting off". The variable defaults to true.
run "security_md_says_active_rule_set_defaults_off" {
  command = plan

  assert {
    condition     = length(aws_ses_active_receipt_rule_set.main) == 0
    error_message = "FINDING: manage_active_rule_set defaults to true, but SECURITY.md says the flag defaults off."
  }
}

# ---------------------------------------------------------------------------
# 2. Least privilege and functional IAM. The store (packages/core/src/store/
# dynamo.ts) uses Scan for dedupe, threading, listing and search.
# ---------------------------------------------------------------------------
run "processor_role_can_scan_the_tables_it_scans" {
  command = plan

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.processor.statement : s.actions]), "dynamodb:Scan")
    error_message = "FINDING: processor role lacks dynamodb:Scan, but ingestRaw -> getMessageByRfcId -> ScanCommand on every inbound message."
  }
}

run "api_role_can_scan_the_tables_it_scans" {
  command = plan

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.api.statement : s.actions]), "dynamodb:Scan")
    error_message = "FINDING: API role lacks dynamodb:Scan, but listThreads/listDrafts/search/readThread/export all Scan."
  }
}

# SES S3 action with kms_key_arn uses the S3 *client-side* encryption client.
# The processor uses plain GetObject, which returns the encrypted envelope.
# command = apply against the mock provider only; nothing leaves this machine.
run "receipt_rule_relies_on_bucket_sse_kms_not_ses_client_side_encryption" {
  command = apply

  assert {
    condition     = one(aws_ses_receipt_rule.store.s3_action).kms_key_arn == null
    error_message = "FINDING: s3_action.kms_key_arn is set. SES then encrypts client-side (S3 encryption client, KMS-wrapped CEK in object metadata). handler.ts reads with plain GetObject and parses ciphertext as MIME."
  }
}

run "lambda_runtime_is_supported" {
  command = plan

  assert {
    condition     = !contains(["nodejs16.x", "nodejs18.x", "nodejs20.x"], aws_lambda_function.processor.runtime)
    error_message = "FINDING: nodejs20.x is past its Lambda deprecation date (Node 20 upstream EOL April 2026). Check the Lambda runtime table; create/update may be blocked."
  }
}

run "processor_has_failure_destination_or_dlq" {
  command = plan

  assert {
    condition     = length(aws_lambda_function.processor.dead_letter_config) > 0
    error_message = "FINDING: processor has no DLQ / on-failure destination. After two async retries an inbound message is silently not indexed."
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

# FINDING (P2): in create mode the resource's dkim_signing_attributes carries
# the sensitive domain_signing_private_key, so local.dkim_tokens is sensitive
# and output "dkim_tokens" (outputs.tf) fails plan with "Output refers to
# sensitive values". The documented domain switch cannot plan today.
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
}
