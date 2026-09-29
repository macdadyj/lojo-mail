resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "REJECT_MESSAGE"
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
  recipients    = [local.mailbox]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.bucket
    object_key_prefix = "raw/"
    kms_key_arn       = aws_kms_key.mail.arn
  }

  depends_on = [aws_s3_bucket_policy.mail]
}

resource "aws_ses_active_receipt_rule_set" "main" {
  count         = var.manage_active_rule_set ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}
