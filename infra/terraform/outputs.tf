output "mailbox" {
  value = local.mailbox
}

output "bucket" {
  value = aws_s3_bucket.mail.bucket
}

output "kms_key_arn" {
  value = aws_kms_key.mail.arn
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
  value       = local.dkim_tokens
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
    imports  = aws_dynamodb_table.imports.name
  }
}
