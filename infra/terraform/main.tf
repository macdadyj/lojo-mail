data "aws_caller_identity" "current" {}

locals {
  account_id       = data.aws_caller_identity.current.account_id
  mailbox          = "${var.local_part}@${var.domain}"
  mail_from_domain = "${var.mail_from_subdomain}.${var.domain}"
  name             = var.project

  processor_bundle = var.processor_bundle != "" ? var.processor_bundle : "${path.module}/placeholders/processor.cjs"
  api_bundle       = var.api_bundle != "" ? var.api_bundle : "${path.module}/placeholders/api.cjs"

  common_env = {
    LOJO_DOMAIN             = var.domain
    LOJO_LOCAL_PART         = var.local_part
    LOJO_REGION             = var.aws_region
    LOJO_BUCKET             = aws_s3_bucket.mail.bucket
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
    LOJO_TABLE_IMPORTS      = aws_dynamodb_table.imports.name
    LOJO_CONFIG_SET         = aws_sesv2_configuration_set.outbound.configuration_set_name
  }
}

resource "terraform_data" "dns_guard" {
  count = var.manage_dns ? 1 : 0

  lifecycle {
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
