locals {
  dkim_tokens = tolist(aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens)

  # Records Jon must publish. Created in Route 53 only when manage_dns is true
  # and the cutover confirmation string is set. DKIM token values are known
  # after the identity exists; until the first apply they show as (known after apply).
  dns_plan = {
    dkim = [for token in local.dkim_tokens : {
      name  = "${token}._domainkey.${var.domain}."
      type  = "CNAME"
      ttl   = var.dns_ttl
      value = "${token}.dkim.amazonses.com"
    }]
    mx_inbound = {
      name    = "${var.domain}."
      type    = "MX"
      ttl     = var.dns_ttl
      value   = "10 inbound-smtp.${var.aws_region}.amazonaws.com"
      warning = "Replaces whatever apex MX the audit found. Do this last."
    }
    mail_from_mx = {
      name    = "${local.mail_from_domain}."
      type    = "MX"
      ttl     = var.dns_ttl
      value   = "10 feedback-smtp.${var.aws_region}.amazonses.com"
      warning = "This name must have exactly one MX or SES rejects the MAIL FROM domain."
    }
    mail_from_spf = {
      name  = "${local.mail_from_domain}."
      type  = "TXT"
      ttl   = var.dns_ttl
      value = "v=spf1 include:amazonses.com ~all"
    }
    apex_spf = {
      name    = "${var.domain}."
      type    = "TXT"
      ttl     = var.dns_ttl
      value   = "v=spf1 include:amazonses.com -all"
      warning = "If an SPF TXT already exists, merge include:amazonses.com into it. A second SPF TXT is a permanent error."
    }
    dmarc = {
      name  = "_dmarc.${var.domain}."
      type  = "TXT"
      ttl   = var.dns_ttl
      value = "v=DMARC1; p=${var.dmarc_policy}; rua=mailto:${local.mailbox}; adkim=s; aspf=s; fo=1"
    }
    tls_rpt = {
      name  = "_smtp._tls.${var.domain}."
      type  = "TXT"
      ttl   = var.dns_ttl
      value = "v=TLSRPTv1; rua=mailto:${local.mailbox}"
    }
    mta_sts = {
      name  = "_mta-sts.${var.domain}."
      type  = "TXT"
      ttl   = var.dns_ttl
      value = "v=STSv1; id=${var.mta_sts_id}"
    }
    mta_sts_policy_host = {
      name  = "mta-sts.${var.domain}."
      type  = "note"
      value = "Serve docs/mta-sts.txt at https://mta-sts.${var.domain}/.well-known/mta-sts.txt before relying on this. The TXT record alone does nothing."
    }
  }
}

resource "aws_route53_record" "dkim" {
  count   = var.manage_dns ? 3 : 0
  zone_id = var.zone_id
  name    = "${local.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = var.dns_ttl
  records = ["${local.dkim_tokens[count.index]}.dkim.amazonses.com"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "mx_inbound" {
  count   = var.manage_dns ? 1 : 0
  zone_id = var.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = var.dns_ttl
  records = ["10 inbound-smtp.${var.aws_region}.amazonaws.com"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "mail_from_mx" {
  count   = var.manage_dns ? 1 : 0
  zone_id = var.zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = var.dns_ttl
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "mail_from_spf" {
  count   = var.manage_dns ? 1 : 0
  zone_id = var.zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = var.dns_ttl
  records = ["v=spf1 include:amazonses.com ~all"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "apex_spf" {
  count   = var.manage_dns ? 1 : 0
  zone_id = var.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = var.dns_ttl
  records = ["v=spf1 include:amazonses.com -all"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "dmarc" {
  count   = var.manage_dns ? 1 : 0
  zone_id = var.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = var.dns_ttl
  records = ["v=DMARC1; p=${var.dmarc_policy}; rua=mailto:${local.mailbox}; adkim=s; aspf=s; fo=1"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "tls_rpt" {
  count   = var.manage_dns ? 1 : 0
  zone_id = var.zone_id
  name    = "_smtp._tls.${var.domain}"
  type    = "TXT"
  ttl     = var.dns_ttl
  records = ["v=TLSRPTv1; rua=mailto:${local.mailbox}"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "mta_sts" {
  count   = var.manage_dns ? 1 : 0
  zone_id = var.zone_id
  name    = "_mta-sts.${var.domain}"
  type    = "TXT"
  ttl     = var.dns_ttl
  records = ["v=STSv1; id=${var.mta_sts_id}"]

  depends_on = [terraform_data.dns_guard]
}
