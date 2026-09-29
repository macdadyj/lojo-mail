resource "aws_s3_bucket" "mail" {
  bucket_prefix = "${var.project}-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "mail" {
  bucket                  = aws_s3_bucket.mail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "mail" {
  bucket = aws_s3_bucket.mail.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "mail" {
  bucket = aws_s3_bucket.mail.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.mail.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id

  rule {
    id     = "abort-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "raw-retention"
    status = "Enabled"

    filter {
      prefix = "raw/"
    }

    expiration {
      days = var.raw_retention_days
    }

    # The processor's DeleteObject leaves a noncurrent version behind.
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  dynamic "rule" {
    for_each = var.ai_context_days > 0 ? [1] : []

    content {
      id     = "ai-context-retention"
      status = "Enabled"

      filter {
        prefix = "ai-context/"
      }

      expiration {
        days = var.ai_context_days
      }

      noncurrent_version_expiration {
        noncurrent_days = 1
      }
    }
  }

  rule {
    id     = "objects-to-ia"
    status = "Enabled"

    filter {
      prefix = "objects/"
    }

    transition {
      days          = 180
      storage_class = "STANDARD_IA"
    }
  }
}

data "aws_iam_policy_document" "mail_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.mail.arn,
      "${aws_s3_bucket.mail.arn}/*",
    ]

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

  statement {
    sid       = "AllowSesPutRaw"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mail.arn}/raw/*"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "StringLike"
      variable = "AWS:SourceArn"
      values   = [local.receipt_rule_arn_pattern]
    }
  }
}

resource "aws_s3_bucket_policy" "mail" {
  bucket = aws_s3_bucket.mail.id
  policy = data.aws_iam_policy_document.mail_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.mail]
}

# The PWA downloads large sealed attachments with a presigned GET.
resource "aws_s3_bucket_cors_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id

  cors_rule {
    allowed_methods = ["GET"]
    allowed_origins = var.web_origins
    allowed_headers = []
    max_age_seconds = 3600
  }
}
