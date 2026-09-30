resource "aws_cloudwatch_log_group" "processor" {
  name              = "/aws/lambda/${var.project}-processor"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.project}-api"
  retention_in_days = var.log_retention_days
}

data "archive_file" "processor" {
  type        = "zip"
  source_file = local.processor_bundle
  output_path = "${path.module}/build/processor.zip"
}

data "archive_file" "api" {
  type        = "zip"
  source_file = local.api_bundle
  output_path = "${path.module}/build/api.zip"
}

resource "aws_lambda_function" "processor" {
  function_name    = "${var.project}-processor"
  role             = aws_iam_role.processor.arn
  runtime          = "nodejs22.x"
  handler          = "processor.handler"
  filename         = data.archive_file.processor.output_path
  source_code_hash = data.archive_file.processor.output_base64sha256
  timeout          = 60
  memory_size      = 512

  reserved_concurrent_executions = var.processor_reserved_concurrency

  dead_letter_config {
    target_arn = aws_sqs_queue.processor_dlq.arn
  }

  environment {
    variables = merge(local.common_env, {
      LOJO_DELETE_RAW = "1"
    })
  }

  depends_on = [aws_cloudwatch_log_group.processor, aws_iam_role_policy.processor]
}

# S3 invokes the processor asynchronously. After the retries, the event goes to
# the DLQ with its raw/ key; docs/RUNBOOK.md has the redrive command.
resource "aws_sqs_queue" "processor_dlq" {
  name                      = "${var.project}-processor-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_lambda_function_event_invoke_config" "processor" {
  function_name                = aws_lambda_function.processor.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 21600
}

resource "aws_cloudwatch_metric_alarm" "processor_dlq" {
  alarm_name          = "${var.project}-processor-dlq-not-empty"
  alarm_description   = "Inbound mail failed processing and is waiting in the DLQ. See docs/RUNBOOK.md, Redrive."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    QueueName = aws_sqs_queue.processor_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "processor_errors" {
  alarm_name          = "${var.project}-processor-errors"
  alarm_description   = "The processor threw. S3 retries twice before the DLQ."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    FunctionName = aws_lambda_function.processor.function_name
  }
}

resource "aws_cloudwatch_log_metric_filter" "login_failures" {
  name           = "${var.project}-login-failures"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "\"login_failed\""

  metric_transformation {
    name          = "LoginFailures"
    namespace     = var.project
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "login_failures" {
  alarm_name          = "${var.project}-login-failures"
  alarm_description   = "Failed web sign-ins across all sources. Sign-in is throttled per source, not globally, so this is the signal for distributed guessing. See docs/SECURITY.md, human sessions."
  namespace           = var.project
  metric_name         = "LoginFailures"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.login_failure_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.login_failures]
}

resource "aws_lambda_function" "api" {
  function_name    = "${var.project}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "api.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 30
  memory_size      = 512

  environment {
    variables = local.common_env
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.api]
}

resource "aws_lambda_permission" "s3_invoke" {
  statement_id   = "AllowS3Invoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.processor.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.mail.arn
  source_account = local.account_id
}

# This resource owns the bucket's entire notification configuration. Anything else
# that writes it (the console, another stack) replaces it; the next plan shows the
# drift, and the raw/ sweep below keeps mail moving meanwhile.
resource "aws_s3_bucket_notification" "raw" {
  bucket = aws_s3_bucket.mail.id

  lambda_function {
    id                  = "raw-to-processor"
    lambda_function_arn = aws_lambda_function.processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "raw/"
  }

  depends_on = [
    aws_lambda_permission.s3_invoke,
    aws_lambda_function_event_invoke_config.processor,
  ]
}

# Safety net: mail must never be stranded in raw/ if the notification is missing or
# broken. The processor lists raw/ and ingests anything older than 5 minutes.
resource "aws_cloudwatch_event_rule" "raw_sweep" {
  name                = "${var.project}-raw-sweep"
  description         = "Ingest anything left under raw/ that the S3 notification did not handle."
  schedule_expression = var.raw_sweep_minutes == 1 ? "rate(1 minute)" : "rate(${var.raw_sweep_minutes} minutes)"
}

resource "aws_cloudwatch_event_target" "raw_sweep" {
  rule  = aws_cloudwatch_event_rule.raw_sweep.name
  arn   = aws_lambda_function.processor.arn
  input = jsonencode({ lojo = "sweep-raw" })
}

resource "aws_lambda_permission" "raw_sweep" {
  statement_id   = "AllowRawSweep"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.processor.function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.raw_sweep.arn
  source_account = local.account_id
}

resource "aws_cloudwatch_log_metric_filter" "raw_swept" {
  name           = "${var.project}-raw-swept"
  log_group_name = aws_cloudwatch_log_group.processor.name
  pattern        = "\"raw_swept\""

  metric_transformation {
    name          = "RawSwept"
    namespace     = var.project
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "raw_swept" {
  alarm_name          = "${var.project}-raw-swept"
  alarm_description   = "The raw/ sweep picked up mail the S3 notification missed. Mail is flowing, but the primary trigger is broken. See docs/DEPLOY.md, If mail sits in raw/."
  namespace           = var.project
  metric_name         = "RawSwept"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.raw_swept]
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
