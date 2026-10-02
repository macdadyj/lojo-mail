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

  # SES authorizes a send against whichever identity is verified: the address
  # itself or its domain. Both are listed; the FromAddress condition still pins
  # the exact addresses.
  extra_send_identity_arns = flatten([
    for address in var.send_from_addresses : [
      "arn:aws:ses:${var.aws_region}:${local.account_id}:identity/${address}",
      "arn:aws:ses:${var.aws_region}:${local.account_id}:identity/${split("@", address)[1]}",
    ]
  ])

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

  # Addresses that hard-bounced or complained are not mailed again from this
  # configuration set, whatever the account-level setting is.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
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

  # SES writes its setup object, and then mail, the moment the rule exists. Without
  # these, a fresh apply can create the rule before bucket SSE-KMS (objects land as
  # AES256) or before the processor trigger (objects sit in raw/).
  depends_on = [
    aws_kms_key.mail,
    aws_s3_bucket_server_side_encryption_configuration.mail,
    aws_s3_bucket_policy.mail,
    aws_lambda_permission.s3_invoke,
    aws_s3_bucket_notification.raw,
  ]
}

resource "aws_ses_active_receipt_rule_set" "main" {
  count         = var.manage_active_rule_set ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name

  depends_on = [aws_ses_receipt_rule.store]
}

# Additional receiving domains (for example lojo.engineering). Identity only:
# DKIM tokens are output for the owner to publish; no DNS is written, and no
# MAIL FROM is configured. A same-named EMAIL_ADDRESS identity, if any, is a
# separate SES resource and is left alone.
resource "aws_sesv2_email_identity" "extra" {
  for_each       = toset(var.extra_receiving_domains)
  email_identity = each.value

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# One rule per extra domain, separate from "store-raw", so the cyberphysical.us
# rule is never edited and rollback is deleting this rule. Same bucket, prefix,
# TLS and scan settings; the same processor ingests it into the same mailbox.
resource "aws_ses_receipt_rule" "store_extra" {
  for_each = var.receiving_stage == "live" ? toset(var.extra_receiving_domains) : toset([])

  name          = "store-raw-${replace(each.value, ".", "-")}"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = [for a in var.extra_receiving_addresses : a if endswith(a, "@${each.value}")]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"
  after         = aws_ses_receipt_rule.store.name

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.bucket
    object_key_prefix = "raw/"
  }

  depends_on = [
    aws_ses_receipt_rule.store,
    aws_kms_key.mail,
    aws_s3_bucket_server_side_encryption_configuration.mail,
    aws_s3_bucket_policy.mail,
    aws_lambda_permission.s3_invoke,
    aws_s3_bucket_notification.raw,
  ]
}
