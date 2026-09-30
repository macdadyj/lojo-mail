data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "processor" {
  name               = "${var.project}-processor"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "api" {
  name               = "${var.project}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

locals {
  # Every table and every index. No Scan, no DeleteItem: empty threads are
  # retired from the sparse index instead of deleted.
  table_arns = flatten([
    for table in [
      aws_dynamodb_table.messages,
      aws_dynamodb_table.threads,
      aws_dynamodb_table.drafts,
      aws_dynamodb_table.audit,
      aws_dynamodb_table.contacts,
      aws_dynamodb_table.budget,
    ] : [table.arn, "${table.arn}/index/*"]
  ])
  table_actions = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:Query",
  ]

  # Bucket SSE-KMS and table encryption. Only usable through those services.
  storage_kms_services = [
    "s3.${var.aws_region}.amazonaws.com",
    "dynamodb.${var.aws_region}.amazonaws.com",
  ]

  ssm_prefix = "arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/lojo-mail"

  # A cross-region inference profile (us.…) routes to the foundation model in
  # several regions, so both ARNs are needed.
  bedrock_foundation_model = replace(var.bedrock_model_id, "/^(us|eu|apac|global)\\./", "")
  bedrock_resources = [
    "arn:aws:bedrock:*::foundation-model/${local.bedrock_foundation_model}",
    "arn:aws:bedrock:${var.aws_region}:${local.account_id}:inference-profile/${var.bedrock_model_id}",
  ]
}

data "aws_iam_policy_document" "processor" {
  statement {
    sid       = "ReadAndDeleteRaw"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.mail.arn}/raw/*"]
  }

  statement {
    sid       = "ListRawForSweep"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mail.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["raw/", "raw/*"]
    }
  }

  statement {
    sid     = "WriteSealedObjects"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.mail.arn}/objects/*",
      "${aws_s3_bucket.mail.arn}/ai-context/*",
    ]
  }

  statement {
    sid       = "StorageEncryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.mail.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.storage_kms_services
    }
  }

  statement {
    sid       = "SealServerCopies"
    actions   = ["kms:GenerateDataKey"]
    resources = [aws_kms_key.mail.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:purpose"
      values   = ["ai-context", "draft"]
    }
  }

  statement {
    sid       = "IndexTables"
    actions   = local.table_actions
    resources = local.table_arns
  }

  statement {
    sid     = "ReadConfig"
    actions = ["ssm:GetParameter"]
    resources = [
      "${local.ssm_prefix}/envelope-public-jwk",
      "${local.ssm_prefix}/grok-api-key",
    ]
  }

  statement {
    sid       = "DeadLetter"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.processor_dlq.arn]
  }

  dynamic "statement" {
    for_each = var.llm_provider == "bedrock" ? [1] : []

    content {
      sid       = "Bedrock"
      actions   = ["bedrock:InvokeModel"]
      resources = local.bedrock_resources
    }
  }

  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.processor.arn}:*"]
  }
}

data "aws_iam_policy_document" "api" {
  statement {
    sid     = "ReadSealedObjects"
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.mail.arn}/objects/*",
      "${aws_s3_bucket.mail.arn}/ai-context/*",
    ]
  }

  # The sealed copy of each approved send is stored like inbound mail.
  statement {
    sid       = "WriteSentCopies"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mail.arn}/objects/*"]
  }

  statement {
    sid       = "StorageEncryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.mail.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.storage_kms_services
    }
  }

  statement {
    sid       = "Drafts"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.mail.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:purpose"
      values   = ["draft"]
    }
  }

  statement {
    sid       = "ReadAiContext"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.mail.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:purpose"
      values   = ["ai-context"]
    }
  }

  statement {
    sid       = "IndexTables"
    actions   = local.table_actions
    resources = local.table_arns
  }

  statement {
    sid     = "ReadConfig"
    actions = ["ssm:GetParameter"]
    resources = [
      for name in [
        "envelope-public-jwk",
        "api-token",
        "api-token-send",
        "session-secret",
        "human-passphrase-hash",
        "pgp-public-key",
        "pgp-signing-key",
        "pgp-signing-passphrase",
        "grok-api-key",
      ] : "${local.ssm_prefix}/${name}"
    ]
  }

  statement {
    sid     = "SendAsMailbox"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [
      local.ses_identity_arn,
      aws_sesv2_configuration_set.outbound.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.mailbox]
    }
  }

  dynamic "statement" {
    for_each = var.llm_provider == "bedrock" ? [1] : []

    content {
      sid       = "Bedrock"
      actions   = ["bedrock:InvokeModel"]
      resources = local.bedrock_resources
    }
  }

  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
}

resource "aws_iam_role_policy" "processor" {
  name   = "processor"
  role   = aws_iam_role.processor.id
  policy = data.aws_iam_policy_document.processor.json
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}
