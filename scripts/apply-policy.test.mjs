import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const TF_DIR = "infra/terraform";
const policy = JSON.parse(readFileSync("infra/iam/apply-policy.json", "utf8"));
const allowed = new Set(policy.Statement.flatMap((statement) => statement.Action));

// Create (and, where the provider reads it back separately, read) actions per resource type.
// Resource types behind flags that default off (create-mode identity, manage_dns) are listed
// as optional: the policy omits them on purpose.
const NEEDS = {
  aws_apigatewayv2_api: ["apigateway:POST", "apigateway:GET"],
  aws_apigatewayv2_integration: ["apigateway:POST"],
  aws_apigatewayv2_route: ["apigateway:POST"],
  aws_apigatewayv2_stage: ["apigateway:POST"],
  aws_cloudwatch_event_rule: ["events:PutRule", "events:DescribeRule"],
  aws_cloudwatch_event_target: ["events:PutTargets", "events:ListTargetsByRule"],
  aws_cloudwatch_log_group: ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:DescribeLogGroups"],
  aws_cloudwatch_log_metric_filter: ["logs:PutMetricFilter", "logs:DescribeMetricFilters"],
  aws_cloudwatch_metric_alarm: ["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:TagResource"],
  aws_dynamodb_table: ["dynamodb:CreateTable", "dynamodb:DescribeTable", "dynamodb:UpdateTimeToLive", "dynamodb:UpdateContinuousBackups", "kms:CreateGrant"],
  aws_iam_role: ["iam:CreateRole", "iam:GetRole", "iam:TagRole"],
  aws_iam_role_policy: ["iam:PutRolePolicy", "iam:GetRolePolicy"],
  aws_kms_alias: ["kms:CreateAlias", "kms:ListAliases"],
  aws_kms_key: ["kms:CreateKey", "kms:DescribeKey", "kms:EnableKeyRotation", "kms:GetKeyPolicy"],
  aws_lambda_function: ["lambda:CreateFunction", "lambda:GetFunction", "iam:PassRole", "lambda:PutFunctionConcurrency"],
  aws_lambda_function_event_invoke_config: ["lambda:PutFunctionEventInvokeConfig", "lambda:GetFunctionEventInvokeConfig"],
  aws_lambda_permission: ["lambda:AddPermission", "lambda:GetPolicy"],
  aws_s3_bucket: ["s3:CreateBucket", "s3:ListBucket", "s3:PutBucketTagging", "s3:GetBucketPolicy"],
  aws_s3_bucket_cors_configuration: ["s3:PutBucketCORS", "s3:GetBucketCORS"],
  aws_s3_bucket_lifecycle_configuration: ["s3:PutLifecycleConfiguration", "s3:GetLifecycleConfiguration"],
  aws_s3_bucket_notification: ["s3:PutBucketNotification", "s3:GetBucketNotification"],
  aws_s3_bucket_ownership_controls: ["s3:PutBucketOwnershipControls", "s3:GetBucketOwnershipControls"],
  aws_s3_bucket_policy: ["s3:PutBucketPolicy", "s3:GetBucketPolicy"],
  aws_s3_bucket_public_access_block: ["s3:PutBucketPublicAccessBlock", "s3:GetBucketPublicAccessBlock"],
  aws_s3_bucket_server_side_encryption_configuration: ["s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration"],
  aws_s3_bucket_versioning: ["s3:PutBucketVersioning", "s3:GetBucketVersioning"],
  aws_ses_active_receipt_rule_set: ["ses:SetActiveReceiptRuleSet", "ses:DescribeActiveReceiptRuleSet"],
  aws_ses_receipt_rule: ["ses:CreateReceiptRule", "ses:DescribeReceiptRule"],
  aws_ses_receipt_rule_set: ["ses:CreateReceiptRuleSet", "ses:DescribeReceiptRuleSet"],
  aws_sesv2_configuration_set: ["ses:CreateConfigurationSet", "ses:GetConfigurationSet"],
  aws_sqs_queue: ["sqs:CreateQueue", "sqs:GetQueueAttributes", "sqs:TagQueue"],
};
const OPTIONAL = new Set(["aws_sesv2_email_identity", "aws_sesv2_email_identity_mail_from_attributes", "aws_route53_record", "terraform_data"]);

function resourceTypes() {
  const types = new Set();
  for (const file of readdirSync(TF_DIR).filter((name) => name.endsWith(".tf"))) {
    for (const match of readFileSync(join(TF_DIR, file), "utf8").matchAll(/^resource "([a-z0-9_]+)"/gm)) types.add(match[1]);
  }
  return [...types].sort();
}

test("[deploy] every Terraform resource type has its create and read actions in infra/iam/apply-policy.json", () => {
  const unmapped = resourceTypes().filter((type) => !NEEDS[type] && !OPTIONAL.has(type));
  assert.deepEqual(unmapped, [], "add the new resource type to NEEDS and its actions to the policy");
  const missing = Object.entries(NEEDS).flatMap(([type, actions]) => actions.filter((action) => !allowed.has(action)).map((action) => `${type}: ${action}`));
  assert.deepEqual(missing, []);
});

test("[deploy] the alarms' cloudwatch:PutMetricAlarm is in the apply policy", () => {
  assert.ok(allowed.has("cloudwatch:PutMetricAlarm"));
});

test("the apply policy passes roles to Lambda only", () => {
  const pass = policy.Statement.filter((statement) => statement.Action.includes("iam:PassRole"));
  assert.equal(pass.length, 1);
  assert.equal(pass[0].Condition?.StringEquals?.["iam:PassedToService"], "lambda.amazonaws.com");
});
