# cyberphysical.us, cyberdevsec.com, and jon@lojo.engineering already exist in
# SES us-east-1. This stack adopts var.domain only. It does not import or edit
# the other identities.
data "aws_sesv2_email_identity" "existing" {
  count          = var.ses_identity_mode == "existing" ? 1 : 0
  email_identity = var.domain
}

resource "aws_sesv2_email_identity" "created" {
  count          = var.ses_identity_mode == "create" ? 1 : 0
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "created" {
  count                  = var.ses_identity_mode == "create" ? 1 : 0
  email_identity         = aws_sesv2_email_identity.created[0].email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "REJECT_MESSAGE"
}

locals {
  ses_identity_arn = one(concat(
    aws_sesv2_email_identity.created[*].arn,
    data.aws_sesv2_email_identity.existing[*].arn,
  ))
  dkim_attributes = one(concat(
    aws_sesv2_email_identity.created[*].dkim_signing_attributes,
    data.aws_sesv2_email_identity.existing[*].dkim_signing_attributes,
  ))
  dkim_tokens = tolist(local.dkim_attributes[0].tokens)

  receipt_rule_arn_pattern = "arn:aws:ses:${var.aws_region}:${local.account_id}:receipt-rule-set/${var.project}:receipt-rule/*"
}

resource "aws_sesv2_configuration_set" "outbound" {
  configuration_set_name = var.project

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = var.project
}

resource "aws_ses_receipt_rule" "store" {
  name          = "store-raw"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = local.receipt_recipients
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.bucket
    object_key_prefix = "raw/"
  }

  depends_on = [aws_s3_bucket_policy.mail]
}

resource "aws_ses_active_receipt_rule_set" "main" {
  count         = var.manage_active_rule_set ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}
