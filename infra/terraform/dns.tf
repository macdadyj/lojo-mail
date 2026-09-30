locals {
  # Published only for a brand-new identity. The audited cyberphysical.us zone
  # already has DKIM, MAIL FROM, SPF, DMARC, and the inbound MX.
  publish_new_domain_dns = var.manage_dns && var.ses_identity_mode == "create"

  dns_plan = {
    region               = var.aws_region
    ses_identity_mode    = var.ses_identity_mode
    applied_by_terraform = local.publish_new_domain_dns ? "new-domain records only, after the confirmation string" : "none — suggestions below are not Route 53 resources"

    leave_untouched = [
      "NS and SOA.",
      "ACM validation CNAMEs (target contains acm-validations.aws).",
      "Every _domainkey CNAME. The audit found six Easy DKIM CNAMEs. Do not add more and do not delete them.",
      "_amazonses TXT (SES verification). Do not delete it.",
      "${local.mail_from_domain} MX (10 feedback-smtp.${var.aws_region}.amazonses.com) and its SPF TXT.",
      "Apex SPF, already v=spf1 include:amazonses.com ~all. Do not add a second SPF TXT. Do not flip ~all to -all as part of standing up receipt.",
      "Apex MX, already 10 inbound-smtp.${var.aws_region}.amazonaws.com. Do not change the target.",
    ]

    optional_cleanup_after_workmail_is_confirmed_gone = [
      "autodiscover.${var.domain} CNAME (WorkMail leftover).",
      "_amazonchime.${var.domain} TXT (WorkMail / Chime leftover).",
    ]

    suggested_additions_not_applied = {
      dmarc = {
        action = "Edit the existing _dmarc TXT in place. One record only."
        name   = "_dmarc.${var.domain}."
        type   = "TXT"
        value  = "v=DMARC1; p=quarantine; pct=100; fo=1; rua=mailto:${local.dmarc_mailbox}"
        note   = "The live policy is already p=quarantine;pct=100;fo=1 with no rua. Keep quarantine. Do not set aspf=s: custom MAIL FROM is mail.${var.domain}, and strict SPF alignment would fail. adkim can stay unset (relaxed) or become s, because Easy DKIM signs as ${var.domain}."
      }
      tls_rpt = {
        action = "Add. Absent from the audit."
        name   = "_smtp._tls.${var.domain}."
        type   = "TXT"
        value  = "v=TLSRPTv1; rua=mailto:${local.dmarc_mailbox}"
      }
      mta_sts_txt = {
        action = "Add only after the policy URL answers over HTTPS."
        name   = "_mta-sts.${var.domain}."
        type   = "TXT"
        value  = "v=STSv1; id=${var.mta_sts_id}"
        policy = "https://mta-sts.${var.domain}/.well-known/mta-sts.txt from docs/mta-sts.txt (mode testing, mx inbound-smtp.${var.aws_region}.amazonaws.com)."
      }
      wkd = {
        action = "Host the public key. No DNS record until that HTTPS host exists."
        url    = "https://openpgpkey.${var.domain}/.well-known/openpgpkey/${var.domain}/hu/<z-base32 SHA-1 of the local part>"
        note   = "Publish only the public key. The hash command is npm run wkd-hash."
      }
      apex_mx_ttl = {
        action = "Do not change the MX target. TTL is 1800 today."
        note   = "Lower the apex MX TTL to 300 only before a future move off us-east-1. Standing up the receipt rule does not need a TTL change."
      }
      dnssec = {
        action = "Optional, later. DNSSEC is off. Registrar is Gandi, managed in Route 53 Domains."
        note   = "Enabling needs a KMS signing key plus a DS record at the registrar. The IAM user grok-rw has Route 53 and Route 53 Domains, not KMS, so it cannot create that key. Do this after mail receives, not as part of the receipt apply."
      }
    }
  }
}

resource "aws_route53_record" "dkim" {
  count   = local.publish_new_domain_dns ? 3 : 0
  zone_id = var.zone_id
  name    = "${local.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = var.dns_ttl
  records = ["${local.dkim_tokens[count.index]}.dkim.amazonses.com"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "mx_inbound" {
  count   = local.publish_new_domain_dns ? 1 : 0
  zone_id = var.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = var.dns_ttl
  records = ["10 inbound-smtp.${var.aws_region}.amazonaws.com"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "mail_from_mx" {
  count   = local.publish_new_domain_dns ? 1 : 0
  zone_id = var.zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = var.dns_ttl
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "mail_from_spf" {
  count   = local.publish_new_domain_dns ? 1 : 0
  zone_id = var.zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = var.dns_ttl
  records = ["v=spf1 include:amazonses.com ~all"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "apex_spf" {
  count   = local.publish_new_domain_dns ? 1 : 0
  zone_id = var.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = var.dns_ttl
  records = ["v=spf1 include:amazonses.com ~all"]

  depends_on = [terraform_data.dns_guard]
}

resource "aws_route53_record" "dmarc" {
  count   = local.publish_new_domain_dns ? 1 : 0
  zone_id = var.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = var.dns_ttl
  records = ["v=DMARC1; p=${var.dmarc_policy}; pct=100; fo=1; rua=mailto:${local.dmarc_mailbox}"]

  depends_on = [terraform_data.dns_guard]
}
