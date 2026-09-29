# Keys and indexes mirror TABLE_SCHEMAS in packages/core/src/store/types.ts.
# The store only uses GetItem, PutItem, UpdateItem, and Query. The `kind`
# indexes are sparse: an item leaves the listing when `kind` is removed.

resource "aws_dynamodb_table" "messages" {
  name                        = "${local.name}-messages"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "id"
  deletion_protection_enabled = true

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

  attribute {
    name = "rfcMessageId"
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

  global_secondary_index {
    name            = "rfc"
    hash_key        = "rfcMessageId"
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
  name                        = "${local.name}-threads"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "id"
  deletion_protection_enabled = true

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "kind"
    type = "S"
  }

  attribute {
    name = "lastDate"
    type = "S"
  }

  global_secondary_index {
    name            = "recent"
    hash_key        = "kind"
    range_key       = "lastDate"
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

resource "aws_dynamodb_table" "drafts" {
  name                        = "${local.name}-drafts"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "id"
  deletion_protection_enabled = true

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "kind"
    type = "S"
  }

  attribute {
    name = "updatedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "recent"
    hash_key        = "kind"
    range_key       = "updatedAt"
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

resource "aws_dynamodb_table" "audit" {
  name                        = "${local.name}-audit"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "day"
  range_key                   = "id"
  deletion_protection_enabled = true

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
  name                        = "${local.name}-contacts"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "email"
  deletion_protection_enabled = true

  attribute {
    name = "email"
    type = "S"
  }

  attribute {
    name = "kind"
    type = "S"
  }

  global_secondary_index {
    name            = "all"
    hash_key        = "kind"
    range_key       = "email"
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

resource "aws_dynamodb_table" "budget" {
  name                        = "${local.name}-budget"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "day"
  deletion_protection_enabled = true

  attribute {
    name = "day"
    type = "S"
  }

  # Login-failure counters (`counter:` keys) set this; daily token rows do not, so they stay.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.mail.arn
  }
}
