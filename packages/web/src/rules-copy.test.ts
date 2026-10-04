import assert from "node:assert/strict";
import test from "node:test";
import { describeChange, describeRule, ruleAuditEvents } from "./rules-copy.ts";
import type { RuleSummary } from "./types.ts";

const trash: RuleSummary = {
  id: "noise",
  name: "Bin noise",
  enabled: true,
  createdBy: "bot",
  match: { from: ["@news.example"], subjectContains: ["unsubscribe"] },
  actions: [{ type: "trash" }],
};

test("a trash rule is described as recoverable", () => {
  assert.equal(describeRule(trash, 30), 'Move mail from @news.example containing "unsubscribe" to Trash, restorable for 30 days');
});

test("a label rule names the label and the sender", () => {
  const rule: RuleSummary = { ...trash, actions: [{ type: "label", labels: ["news"] }] };
  assert.equal(describeRule(rule, 30), "Label mail from @news.example containing \"unsubscribe\" with news");
});

test("recent changes name who, the rule, and why", () => {
  const line = describeChange({
    at: "2026-10-04T12:00:00.000Z",
    action: "rules.bot_upsert",
    actor: "agent:mail",
    outcome: "ok",
    detail: "rule:noise why:newsletters to trash sha256:abc",
  });
  assert.equal(line, "agent:mail saved noise: newsletters to trash");
  const events = ruleAuditEvents([
    { at: "t", action: "message.trashed", outcome: "ok" },
    { at: "t", action: "rules.undone", actor: "agent:mail", outcome: "ok", detail: "rule:noise op:upsert why:too broad undid:newsletters sha256:abc" },
  ]);
  assert.equal(events.length, 1);
  assert.match(describeChange(events[0]!), /undid a change to noise: too broad/);
});
