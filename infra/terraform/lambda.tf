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
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.processor.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.mail.arn
}

resource "aws_s3_bucket_notification" "raw" {
  bucket = aws_s3_bucket.mail.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "raw/"
  }

  depends_on = [aws_lambda_permission.s3_invoke]
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
