output "mailbox" {
  value = local.mailbox
}

output "bucket" {
  value = aws_s3_bucket.mail.bucket
}

output "web_blob_origin" {
  description = "Exact origin of presigned attachment URLs. Pass as VITE_LOJO_BLOB_ORIGIN when building the web app."
  value       = "https://${aws_s3_bucket.mail.bucket}.s3.${var.aws_region}.amazonaws.com"
}

output "receiving" {
  description = "Addresses the receipt rule accepts now."
  value = {
    stage      = var.receiving_stage
    recipients = local.receipt_recipients
  }
}

output "kms_key_arn" {
  value = aws_kms_key.mail.arn
}

output "processor_dlq_url" {
  value = aws_sqs_queue.processor_dlq.url
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

output "ses_identity_mode" {
  value = var.ses_identity_mode
}

output "ses_identity_arn" {
  value = local.ses_identity_arn
}

output "dkim_tokens" {
  description = "Already published when ses_identity_mode is existing. Do not create new CNAMEs from these."
  value       = nonsensitive(local.dkim_tokens)
}

output "dns_plan" {
  value = local.dns_plan
}

output "receipt_rule_set" {
  value = aws_ses_receipt_rule_set.main.rule_set_name
}

output "receipt_rule_set_active" {
  value = var.manage_active_rule_set
}

output "manage_dns" {
  value = var.manage_dns
}

output "tables" {
  value = {
    messages = aws_dynamodb_table.messages.name
    threads  = aws_dynamodb_table.threads.name
    drafts   = aws_dynamodb_table.drafts.name
    audit    = aws_dynamodb_table.audit.name
    contacts = aws_dynamodb_table.contacts.name
    budget   = aws_dynamodb_table.budget.name
  }
}

output "web_hosting" {
  description = "Null unless web_hosting_enabled. bucket and app_prefix are where scripts/deploy-web.sh uploads."
  value = var.web_hosting_enabled ? {
    app_url                 = "https://${local.web_app_host}"
    mta_sts_policy_url      = "https://${local.web_mta_sts_host}/.well-known/mta-sts.txt"
    bucket                  = aws_s3_bucket.web[0].bucket
    app_prefix              = "app/"
    app_distribution_id     = aws_cloudfront_distribution.app[0].id
    mta_sts_distribution_id = aws_cloudfront_distribution.mta_sts[0].id
  } : null
}
