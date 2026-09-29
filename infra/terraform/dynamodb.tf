resource "aws_dynamodb_table" "messages" {
  name         = "${local.name}-messages"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "threadId"
    type = "S"
  }

  attribute {
    name = "date"
    type = "S"
  }

  attribute {
    name = "folder"
    type = "S"
  }

  global_secondary_index {
    name            = "thread"
    hash_key        = "threadId"
    range_key       = "date"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "folder"
    hash_key        = "folder"
    range_key       = "date"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.mail.arn
  }
}

resource "aws_dynamodb_table" "threads" {
  name         = "${local.name}-threads"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.mail.arn
  }
}

resource "aws_dynamodb_table" "drafts" {
  name         = "${local.name}-drafts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.mail.arn
  }
}

resource "aws_dynamodb_table" "audit" {
  name         = "${local.name}-audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "day"
  range_key    = "id"

  attribute {
    name = "day"
    type = "S"
  }

  attribute {
    name = "id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.mail.arn
  }
}

resource "aws_dynamodb_table" "contacts" {
  name         = "${local.name}-contacts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email"

  attribute {
    name = "email"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.mail.arn
  }
}

resource "aws_dynamodb_table" "budget" {
  name         = "${local.name}-budget"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "day"

  attribute {
    name = "day"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.mail.arn
  }
}

resource "aws_dynamodb_table" "imports" {
  name         = "${local.name}-imports"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "key"

  attribute {
    name = "key"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.mail.arn
  }
}
