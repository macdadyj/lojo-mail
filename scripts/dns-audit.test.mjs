import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { auditZone, parseRoute53Export } from "./dns-audit.mjs";

test("audited zone shape is already on SES us-east-1 and is not a cutover", async () => {
  const raw = await readFile(new URL("../fixtures/dns/example-zone.json", import.meta.url), "utf8");
  const records = parseRoute53Export(raw);
  assert.equal(records.length, 18);
  const report = auditZone(records, "cyberphysical.us");
  assert.equal(report.blockers, 0);
  const messages = report.findings.map((finding) => finding.message).join("\n");
  assert.match(messages, /already points at SES inbound in us-east-1/);
  assert.match(messages, /TTL 1800/);
  assert.match(messages, /Do not publish a second SPF TXT/);
  assert.match(messages, /without rua/);
  assert.match(messages, /Protected\. ACM/);
  assert.match(messages, /_amazonses/);
  assert.match(messages, /6 Easy DKIM/);
  assert.match(messages, /feedback endpoint/);
  assert.match(messages, /autodiscover is a WorkMail leftover/);
  assert.match(messages, /_amazonchime TXT is a WorkMail leftover/);
  assert.match(messages, /Do not edit them/);
  const website = report.findings.find((finding) => finding.name === "www.cyberphysical.us.");
  assert.equal(website?.level, "info");
  assert.match(website?.message ?? "", /Leave it alone/);
});

test("a non-SES apex MX is still a blocker", () => {
  const report = auditZone(
    [
      { name: "example.com.", type: "SOA", ttl: 900, values: ["ns. host. 1 7200 900 1209600 86400"] },
      { name: "example.com.", type: "NS", ttl: 172800, values: ["ns."] },
      { name: "example.com.", type: "MX", ttl: 3600, values: ["10 mx1.old-mail.example."] },
    ],
    "example.com",
  );
  assert.ok(report.blockers >= 1);
  assert.match(report.findings.map((finding) => finding.message).join("\n"), /not SES/);
});
