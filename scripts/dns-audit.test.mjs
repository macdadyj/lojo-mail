import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { auditZone, parseRoute53Export } from "./dns-audit.mjs";

test("synthetic 17-record zone is not treated as mail-free", async () => {
  const raw = await readFile(new URL("../fixtures/dns/example-zone.json", import.meta.url), "utf8");
  const records = parseRoute53Export(raw);
  assert.equal(records.length, 17);
  const report = auditZone(records, "cyberphysical.us");
  assert.ok(report.blockers >= 1);
  const messages = report.findings.map((f) => f.message).join("\n");
  assert.match(messages, /Existing apex MX/);
  assert.match(messages, /Existing SPF/);
  assert.match(messages, /Existing DMARC/);
  assert.match(messages, /Existing DKIM/);
  assert.match(messages, /exactly one MX/);
  assert.match(messages, /Autodiscover/);
  assert.match(messages, /Do not edit them/);
  const website = report.findings.find((f) => f.name === "www.cyberphysical.us.");
  assert.equal(website?.level, "info");
});
