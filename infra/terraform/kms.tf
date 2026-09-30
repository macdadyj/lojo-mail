resource "aws_kms_key" "mail" {
  description             = "lojo-mail data key for ${var.domain}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "RootAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "SesUseOfKey"
        Effect    = "Allow"
        Principal = { Service = "ses.amazonaws.com" }
        # SES writes raw/ into the bucket, whose default SSE-KMS uses this key.
        Action = [
          "kms:GenerateDataKey*",
          "kms:Encrypt",
          "kms:Decrypt",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
          StringLike = {
            "aws:SourceArn" = local.receipt_rule_arn_pattern
          }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "mail" {
  name          = "alias/${var.project}"
  target_key_id = aws_kms_key.mail.key_id
}
