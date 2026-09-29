data "aws_caller_identity" "current" {}

locals {
  account_id         = data.aws_caller_identity.current.account_id
  mailbox            = "${var.local_part}@${var.domain}"
  dmarc_mailbox      = "${var.dmarc_rua_local_part}@${var.domain}"
  test_mailbox       = "${var.receiving_test_local_part}@${var.domain}"
  receipt_recipients = var.receiving_stage == "live" ? [local.mailbox, local.dmarc_mailbox] : [local.test_mailbox]
  mail_from_domain   = "${var.mail_from_subdomain}.${var.domain}"
  name               = var.project

  processor_bundle = var.processor_bundle != "" ? var.processor_bundle : "${path.module}/placeholders/processor.mjs"
  api_bundle       = var.api_bundle != "" ? var.api_bundle : "${path.module}/placeholders/api.mjs"

  common_env = {
    LOJO_DOMAIN             = var.domain
    LOJO_LOCAL_PART         = var.local_part
    LOJO_REGION             = var.aws_region
    LOJO_BUCKET             = aws_s3_bucket.mail.bucket
    LOJO_KMS_KEY_ID         = aws_kms_key.mail.arn
    LOJO_AI_CONTEXT_DAYS    = tostring(var.ai_context_days)
    LOJO_DMARC_LOCAL_PART   = var.dmarc_rua_local_part
    LOJO_LLM_PROVIDER       = var.llm_provider
    LOJO_DAILY_TOKEN_BUDGET = tostring(var.daily_token_budget)
    LOJO_MAX_BODY_CHARS     = tostring(var.max_body_chars)
    LOJO_BEDROCK_MODEL_ID   = var.bedrock_model_id
    LOJO_GROK_BASE_URL      = var.grok_base_url
    LOJO_GROK_MODEL         = var.grok_model
    LOJO_OLLAMA_BASE_URL    = var.ollama_base_url
    LOJO_OLLAMA_MODEL       = var.ollama_model
    LOJO_OLLAMA_EMBED_MODEL = var.ollama_embed_model
    LOJO_PUBLIC_KEY_PARAM   = "/lojo-mail/envelope-public-jwk"
    LOJO_API_TOKEN_PARAM    = "/lojo-mail/api-token"
    LOJO_SEND_TOKEN_PARAM   = "/lojo-mail/api-token-send"
    LOJO_GROK_KEY_PARAM     = "/lojo-mail/grok-api-key"
    LOJO_TABLE_MESSAGES     = aws_dynamodb_table.messages.name
    LOJO_TABLE_THREADS      = aws_dynamodb_table.threads.name
    LOJO_TABLE_DRAFTS       = aws_dynamodb_table.drafts.name
    LOJO_TABLE_AUDIT        = aws_dynamodb_table.audit.name
    LOJO_TABLE_CONTACTS     = aws_dynamodb_table.contacts.name
    LOJO_TABLE_BUDGET       = aws_dynamodb_table.budget.name
    LOJO_CONFIG_SET         = aws_sesv2_configuration_set.outbound.configuration_set_name
  }
}

resource "terraform_data" "dns_guard" {
  count = var.manage_dns ? 1 : 0

  lifecycle {
    precondition {
      condition     = var.ses_identity_mode == "create"
      error_message = "ses_identity_mode=existing refuses manage_dns. cyberphysical.us already has SES DNS in us-east-1. Leave manage_dns false. Suggested additions are output dns_plan, not Route 53 resources."
    }

    precondition {
      condition     = var.dns_cutover_confirmation == "I-audited-the-existing-zone"
      error_message = "Refusing to write Route 53 records. Set dns_cutover_confirmation to I-audited-the-existing-zone only after the checklist in docs/RUNBOOK.md."
    }

    precondition {
      condition     = length(var.zone_id) > 0
      error_message = "manage_dns requires zone_id. This stack will not look up a hosted zone by name."
    }
  }
}
