# Optional static hosting for the PWA and the MTA-STS policy. Off by default.
#
# One private bucket (no public access, SSE-S3, no website endpoint) with two prefixes:
#   app/       the contents of packages/web/dist, uploaded by scripts/deploy-web.sh
#   mta-sts/   .well-known/mta-sts.txt, from docs/mta-sts.txt
# Two CloudFront distributions read it through origin access control, one per host, so the
# app never serves the policy file and the policy host never serves the app. One ACM
# certificate (us-east-1, DNS validation) covers both hosts. CloudFront has no
# per-distribution fee; at personal-mailbox traffic this stays inside the free tiers.

locals {
  web_hosting      = var.web_hosting_enabled ? 1 : 0
  web_app_host     = "${var.web_app_label}.${var.domain}"
  web_mta_sts_host = "${var.web_mta_sts_label}.${var.domain}"
  web_hosts        = [local.web_app_host, local.web_mta_sts_host]

  # The policy is read from the build so the header can never drift from the <meta> tag.
  web_headers_file = var.web_hosting_enabled ? file("${path.module}/../../packages/web/dist/_headers") : ""
  web_csp          = try(regex("(?m)^\\s*Content-Security-Policy:\\s*(.+?)\\s*$", local.web_headers_file)[0], "")

  # AWS managed cache policy CachingOptimized. It honours the origin's Cache-Control
  # (deploy-web.sh sets no-cache on index.html, sw.js and the manifest).
  web_cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  # Route 53 alias zone id for every CloudFront distribution.
  cloudfront_zone_id = "Z2FDTNDATAQYW2"
}

resource "aws_s3_bucket" "web" {
  count = local.web_hosting

  bucket_prefix = "${var.project}-web-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "web" {
  count = local.web_hosting

  bucket                  = aws_s3_bucket.web[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  count = local.web_hosting

  bucket = aws_s3_bucket.web[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  count = local.web_hosting

  bucket = aws_s3_bucket.web[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "web" {
  count = local.web_hosting

  bucket = aws_s3_bucket.web[0].id

  rule {
    id     = "abort-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "web_bucket" {
  count = local.web_hosting

  statement {
    sid       = "CloudFrontReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web[0].arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.app[0].arn, aws_cloudfront_distribution.mta_sts[0].arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.web[0].arn, "${aws_s3_bucket.web[0].arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  count = local.web_hosting

  bucket = aws_s3_bucket.web[0].id
  policy = data.aws_iam_policy_document.web_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.web]
}

# The policy file is small and changes only with docs/mta-sts.txt, so Terraform owns it.
resource "aws_s3_object" "mta_sts_policy" {
  count = local.web_hosting

  bucket        = aws_s3_bucket.web[0].id
  key           = "mta-sts/.well-known/mta-sts.txt"
  source        = "${path.module}/../../docs/mta-sts.txt"
  etag          = filemd5("${path.module}/../../docs/mta-sts.txt")
  content_type  = "text/plain; charset=utf-8"
  cache_control = "max-age=300"
}

resource "aws_acm_certificate" "web" {
  count = local.web_hosting

  domain_name               = local.web_app_host
  subject_alternative_names = [local.web_mta_sts_host]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = length(local.web_csp) > 0
      error_message = "packages/web/dist/_headers has no Content-Security-Policy. Build the web app first (docs/RUNBOOK.md section 9)."
    }
  }
}

# New names under app. and mta-sts. only. allow_overwrite stays false so an existing record is an error, not an edit.
resource "aws_route53_record" "web_cert_validation" {
  # Static keys, so the plan does not need the certificate's apply-time options to size the map.
  for_each = var.web_hosting_enabled ? toset(local.web_hosts) : toset([])

  zone_id = var.zone_id
  name    = one([for option in aws_acm_certificate.web[0].domain_validation_options : option.resource_record_name if option.domain_name == each.value])
  type    = one([for option in aws_acm_certificate.web[0].domain_validation_options : option.resource_record_type if option.domain_name == each.value])
  ttl     = 60
  records = [one([for option in aws_acm_certificate.web[0].domain_validation_options : option.resource_record_value if option.domain_name == each.value])]

  allow_overwrite = false
}

resource "aws_acm_certificate_validation" "web" {
  count = local.web_hosting

  certificate_arn         = aws_acm_certificate.web[0].arn
  validation_record_fqdns = [for record in aws_route53_record.web_cert_validation : record.fqdn]
}

resource "aws_cloudfront_origin_access_control" "web" {
  count = local.web_hosting

  name                              = "${var.project}-web"
  description                       = "Signed reads of the private web bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "app" {
  count = local.web_hosting

  name    = "${var.project}-web-app"
  comment = "Headers from packages/web/dist/_headers, plus HSTS"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.web_csp
      override                = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "mta_sts" {
  count = local.web_hosting

  name    = "${var.project}-web-mta-sts"
  comment = "MTA-STS policy host"

  security_headers_config {
    content_type_options {
      override = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
  }
}

resource "aws_cloudfront_distribution" "app" {
  count = local.web_hosting

  enabled             = true
  comment             = "${var.project} web app"
  aliases             = [local.web_app_host]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  is_ipv6_enabled     = true

  origin {
    domain_name              = aws_s3_bucket.web[0].bucket_regional_domain_name
    origin_id                = "web-app"
    origin_path              = "/app"
    origin_access_control_id = aws_cloudfront_origin_access_control.web[0].id
  }

  default_cache_behavior {
    target_origin_id           = "web-app"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.web_cache_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.app[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.web[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_cloudfront_distribution" "mta_sts" {
  count = local.web_hosting

  enabled         = true
  comment         = "${var.project} MTA-STS policy"
  aliases         = [local.web_mta_sts_host]
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    domain_name              = aws_s3_bucket.web[0].bucket_regional_domain_name
    origin_id                = "web-mta-sts"
    origin_path              = "/mta-sts"
    origin_access_control_id = aws_cloudfront_origin_access_control.web[0].id
  }

  default_cache_behavior {
    target_origin_id           = "web-mta-sts"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.web_cache_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.mta_sts[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.web[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "web_alias" {
  for_each = var.web_hosting_enabled ? {
    "app-A"        = { name = local.web_app_host, type = "A", dist = aws_cloudfront_distribution.app[0] }
    "app-AAAA"     = { name = local.web_app_host, type = "AAAA", dist = aws_cloudfront_distribution.app[0] }
    "mta-sts-A"    = { name = local.web_mta_sts_host, type = "A", dist = aws_cloudfront_distribution.mta_sts[0] }
    "mta-sts-AAAA" = { name = local.web_mta_sts_host, type = "AAAA", dist = aws_cloudfront_distribution.mta_sts[0] }
  } : {}

  zone_id         = var.zone_id
  name            = each.value.name
  type            = each.value.type
  allow_overwrite = false

  alias {
    name                   = each.value.dist.domain_name
    zone_id                = local.cloudfront_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "tls_rpt" {
  count = var.web_hosting_enabled && var.web_hosting_publish_tls_rpt ? 1 : 0

  zone_id         = var.zone_id
  name            = "_smtp._tls.${var.domain}"
  type            = "TXT"
  ttl             = var.dns_ttl
  records         = ["v=TLSRPTv1; rua=mailto:${local.dmarc_mailbox}"]
  allow_overwrite = false
}

resource "aws_route53_record" "mta_sts_txt" {
  count = var.web_hosting_enabled && var.web_hosting_publish_mta_sts_txt ? 1 : 0

  zone_id         = var.zone_id
  name            = "_mta-sts.${var.domain}"
  type            = "TXT"
  ttl             = var.dns_ttl
  records         = ["v=STSv1; id=${var.mta_sts_id}"]
  allow_overwrite = false
}
