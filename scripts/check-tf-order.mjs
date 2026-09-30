// Asserts creation order that tftest cannot see: nothing may let SES deliver before
// the bucket encrypts with the stack key and raw/ objects reach the processor.
// Run after `terraform init` (npm run infra:validate does both).
import { spawnSync } from "node:child_process";

const REQUIRED = {
  "aws_ses_receipt_rule.store": [
    "aws_kms_key.mail",
    "aws_s3_bucket_server_side_encryption_configuration.mail",
    "aws_s3_bucket_policy.mail",
    "aws_lambda_permission.s3_invoke",
    "aws_s3_bucket_notification.raw",
    "aws_lambda_function.processor",
  ],
  "aws_ses_active_receipt_rule_set.main": ["aws_ses_receipt_rule.store"],
  "aws_s3_bucket_notification.raw": ["aws_lambda_permission.s3_invoke", "aws_lambda_function.processor"],
};

const out = spawnSync("terraform", ["-chdir=infra/terraform", "graph"], { encoding: "utf8" });
if (out.status !== 0) {
  console.error(out.stderr || "terraform graph failed");
  process.exit(1);
}

const edges = new Map();
const node = (label) => label.replace(/^\[root\] /, "").replace(/ \(expand\)$/, "").replace(/\[\d+\]$/, "");
for (const match of out.stdout.matchAll(/"([^"]+)"\s*->\s*"([^"]+)"/g)) {
  const from = node(match[1]);
  const to = node(match[2]);
  if (!edges.has(from)) edges.set(from, new Set());
  edges.get(from).add(to);
}

function reaches(from, target) {
  const seen = new Set();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of edges.get(current) ?? []) stack.push(next);
  }
  return false;
}

const missing = [];
for (const [resource, dependencies] of Object.entries(REQUIRED)) {
  if (!edges.has(resource)) missing.push(`${resource} is not in the graph`);
  for (const dependency of dependencies) {
    if (!reaches(resource, dependency)) missing.push(`${resource} must wait for ${dependency}`);
  }
}

if (missing.length > 0) {
  console.error(`Terraform creation order is unsafe:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`terraform order ok (${Object.values(REQUIRED).flat().length} dependencies)`);
