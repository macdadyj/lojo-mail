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

data "aws_iam_policy_document" "processor" {
  statement {
    sid       = "ReadRawWriteObjects"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.mail.arn}/raw/*"]
  }

  statement {
    sid       = "WriteSealedObjects"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.mail.arn}/objects/*"]
  }

  statement {
    sid = "KmsForMail"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.mail.arn]
  }

  statement {
    sid = "IndexTables"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:DeleteItem",
    ]
    resources = [
      aws_dynamodb_table.messages.arn,
      "${aws_dynamodb_table.messages.arn}/index/*",
      aws_dynamodb_table.threads.arn,
      aws_dynamodb_table.drafts.arn,
      aws_dynamodb_table.audit.arn,
      aws_dynamodb_table.contacts.arn,
      aws_dynamodb_table.budget.arn,
      aws_dynamodb_table.imports.arn,
    ]
  }

  statement {
    sid       = "ReadConfig"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/lojo-mail/*"]
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
    sid       = "ReadSealedObjects"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.mail.arn}/objects/*"]
  }

  statement {
    sid = "KmsDecrypt"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.mail.arn]
  }

  statement {
    sid = "IndexTables"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:DeleteItem",
    ]
    resources = [
      aws_dynamodb_table.messages.arn,
      "${aws_dynamodb_table.messages.arn}/index/*",
      aws_dynamodb_table.threads.arn,
      aws_dynamodb_table.drafts.arn,
      aws_dynamodb_table.audit.arn,
      aws_dynamodb_table.contacts.arn,
      aws_dynamodb_table.budget.arn,
      aws_dynamodb_table.imports.arn,
    ]
  }

  statement {
    sid       = "ReadConfig"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/lojo-mail/*"]
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
