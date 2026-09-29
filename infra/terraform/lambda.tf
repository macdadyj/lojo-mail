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
  runtime          = "nodejs20.x"
  handler          = "processor.handler"
  filename         = data.archive_file.processor.output_path
  source_code_hash = data.archive_file.processor.output_base64sha256
  timeout          = 60
  memory_size      = 512

  environment {
    variables = local.common_env
  }

  depends_on = [aws_cloudwatch_log_group.processor]
}

resource "aws_lambda_function" "api" {
  function_name    = "${var.project}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs20.x"
  handler          = "api.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 30
  memory_size      = 512

  environment {
    variables = local.common_env
  }

  depends_on = [aws_cloudwatch_log_group.api]
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
