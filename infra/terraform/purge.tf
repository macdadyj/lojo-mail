# Empties Trash after the retention window: the only hard delete in the stack.
# It runs as its own function and role, apart from the processor (which parses
# hostile mail) and the API (which faces the internet). It opens no mail, reads
# no secrets, and holds DeleteItem and DeleteObject only when trash_purge_mode
# is "purge". The code is packages/core/src/trash/purge.ts; see docs/SECURITY.md.

resource "aws_cloudwatch_log_group" "trash_purge" {
  name              = "/aws/lambda/${var.project}-trash-purge"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "trash_purge" {
  name               = "${var.project}-trash-purge"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "trash_purge" {
  statement {
    sid     = "ListTrash"
    actions = ["dynamodb:Query", "dynamodb:GetItem"]
    resources = [
      aws_dynamodb_table.messages.arn,
      "${aws_dynamodb_table.messages.arn}/index/*",
    ]
  }

  statement {
    sid       = "RefreshThreads"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.threads.arn]
  }

  statement {
    sid       = "Audit"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.audit.arn]
  }

  statement {
    sid       = "TableEncryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.mail.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.aws_region}.amazonaws.com"]
    }
  }

  dynamic "statement" {
    for_each = var.trash_purge_mode == "purge" ? [1] : []

    content {
      sid       = "PurgeExpiredTrash"
      actions   = ["dynamodb:DeleteItem"]
      resources = [aws_dynamodb_table.messages.arn]
    }
  }

  # Versioned bucket: a delete leaves a noncurrent version for 30 days (s3.tf).
  dynamic "statement" {
    for_each = var.trash_purge_mode == "purge" ? [1] : []

    content {
      sid     = "DeletePurgedObjects"
      actions = ["s3:DeleteObject"]
      resources = [
        "${aws_s3_bucket.mail.arn}/objects/*",
        "${aws_s3_bucket.mail.arn}/ai-context/*",
      ]
    }
  }

  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.trash_purge.arn}:*"]
  }
}

resource "aws_iam_role_policy" "trash_purge" {
  name   = "trash-purge"
  role   = aws_iam_role.trash_purge.id
  policy = data.aws_iam_policy_document.trash_purge.json
}

resource "aws_lambda_function" "trash_purge" {
  function_name    = "${var.project}-trash-purge"
  role             = aws_iam_role.trash_purge.arn
  runtime          = "nodejs22.x"
  handler          = "processor.purge"
  filename         = data.archive_file.processor.output_path
  source_code_hash = data.archive_file.processor.output_base64sha256
  timeout          = 300
  memory_size      = 256

  # One run at a time: two overlapping runs would only race on the same rows.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      LOJO_REGION         = var.aws_region
      LOJO_BUCKET         = aws_s3_bucket.mail.bucket
      LOJO_TRASH_PURGE    = var.trash_purge_mode
      LOJO_TABLE_MESSAGES = aws_dynamodb_table.messages.name
      LOJO_TABLE_THREADS  = aws_dynamodb_table.threads.name
      LOJO_TABLE_DRAFTS   = aws_dynamodb_table.drafts.name
      LOJO_TABLE_AUDIT    = aws_dynamodb_table.audit.name
      LOJO_TABLE_CONTACTS = aws_dynamodb_table.contacts.name
      LOJO_TABLE_BUDGET   = aws_dynamodb_table.budget.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.trash_purge, aws_iam_role_policy.trash_purge]
}

resource "aws_cloudwatch_event_rule" "trash_purge" {
  name                = "${var.project}-trash-purge"
  description         = "Daily: audit (report) or delete (purge) trash past its retention window."
  schedule_expression = "rate(1 day)"
  state               = var.trash_purge_mode == "off" ? "DISABLED" : "ENABLED"
}

resource "aws_cloudwatch_event_target" "trash_purge" {
  rule  = aws_cloudwatch_event_rule.trash_purge.name
  arn   = aws_lambda_function.trash_purge.arn
  input = jsonencode({ lojo = "trash-purge" })
}

resource "aws_lambda_permission" "trash_purge" {
  statement_id   = "AllowTrashPurgeSchedule"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.trash_purge.function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.trash_purge.arn
  source_account = local.account_id
}

resource "aws_cloudwatch_metric_alarm" "trash_purge_errors" {
  alarm_name          = "${var.project}-trash-purge-errors"
  alarm_description   = "The trash purge failed. Nothing is lost: trash stays until a run succeeds. See docs/RUNBOOK.md, Trash purge."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    FunctionName = aws_lambda_function.trash_purge.function_name
  }
}
