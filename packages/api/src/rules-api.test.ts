import assert from "node:assert/strict";
import test from "node:test";
import { RULES_KEY } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import { testApp } from "./test-app.ts";

const RULES = {
  trashRetentionDays: 30,
  rules: [
    { id: "leases", name: "Leases", match: { subjectContains: ["lease"] }, actions: [{ type: "label", labels: ["home"] }] },
    {
      id: "mina",
      name: "Answer Mina",
      match: { from: ["mina@example.com"] },
      actions: [{ type: "reply", reply: { mode: "shadow", template: "Thanks, I will reply soon.\n\nJon", allowSenders: ["mina@example.com"] } }],
    },
  ],
};

const LIVE = JSON.parse(JSON.stringify(RULES).replace('"mode":"shadow"', '"mode":"autoSend"')) as typeof RULES;

test("only a signed-in human can write rules; no token can, however broad", async () => {
  const t = await testApp();
  for (const token of ["write-token", "send-token", "admin-token", "bridge-token"]) {
    const res = await t.call("/v1/rules", { method: "PUT", token, body: RULES });
    assert.equal(res.status, 403, token);
  }
  const session = await t.login();
  const early = await t.call("/v1/rules", { method: "PUT", token: session, body: LIVE });
  assert.equal(early.status, 400);
  assert.match(String(early.json.error), /shadow mode first/);
  assert.equal((await t.call("/v1/rules", { method: "PUT", token: session, body: RULES })).status, 200);
  const saved = await t.call("/v1/rules", { method: "PUT", token: session, body: LIVE });
  assert.equal(saved.status, 200, saved.text);
  const read = await t.call("/v1/rules", { token: "read-token" });
  const rules = (read.json.rules as { rules: Array<{ id: string; createdBy: string }> }).rules;
  assert.deepEqual(rules.map((rule) => [rule.id, rule.createdBy]), [["leases", "human"], ["mina", "human"]]);
  assert.equal(read.json.autoSendEnabled, false);
  const events = (await t.store.listAudit(50)).filter((event) => event.action === "rules.updated");
  assert.match(events[0]?.detail ?? "", /live:mina shadow:none/);
  assert.match(events[1]?.detail ?? "", /live:none shadow:mina/);
});

test("an empty ruleset (no rules object yet) reads as no rules", async () => {
  const t = await testApp();
  const res = await t.call("/v1/rules", { token: "read-token" });
  assert.equal(res.status, 200);
  assert.deepEqual((res.json.rules as { rules: unknown[] }).rules, []);
});

test("AccessDenied on the rules object is a 503, never an empty ruleset that a switch would write back", async () => {
  const t = await testApp();
  const session = await t.login();
  await t.call("/v1/rules", { method: "PUT", token: session, body: RULES });
  const saved = t.blobs.objects.get(RULES_KEY);
  const get = t.blobs.get.bind(t.blobs);
  t.blobs.get = async (key) => {
    if (key === RULES_KEY) throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
    return get(key);
  };

  const read = await t.call("/v1/rules", { token: "read-token" });
  assert.equal(read.status, 503);
  assert.equal(read.json.code, "unavailable");
  assert.match(String(read.json.error), /s3:ListBucket on the rules\/ prefix/);
  assert.equal((await t.call("/v1/rules/switches", { token: "write-token", body: { paused: true } })).status, 503);
  assert.equal((await t.call("/v1/rules/mina/disable", { token: "write-token", body: {} })).status, 503);
  assert.deepEqual(t.blobs.objects.get(RULES_KEY), saved, "the stored rules were not overwritten");
});

test("invalid rules are a 400 with the reason", async () => {
  const t = await testApp();
  const session = await t.login();
  const res = await t.call("/v1/rules", { method: "PUT", token: session, body: { rules: [{ id: "x", name: "x", match: {}, actions: [{ type: "trash" }] }] } });
  assert.equal(res.status, 400);
  assert.match(String(res.json.error), /catch-all/);
});

test("a write token can pause, engage the kill switch and disable a rule, but only Jon can undo it", async () => {
  const t = await testApp();
  const session = await t.login();
  await t.call("/v1/rules", { method: "PUT", token: session, body: RULES });
  assert.equal((await t.call("/v1/rules/switches", { token: "read-token", body: { killSwitch: true } })).status, 403);
  assert.equal((await t.call("/v1/rules/switches", { token: "write-token", body: { killSwitch: true } })).status, 200);
  assert.equal((await t.call("/v1/rules/switches", { token: "write-token", body: { killSwitch: false } })).status, 403);
  assert.equal((await t.call("/v1/rules/switches", { token: "admin-token", body: { paused: false } })).status, 403);
  assert.equal((await t.call("/v1/rules/switches", { token: session, body: { killSwitch: false } })).status, 200);

  const disabled = await t.call("/v1/rules/mina/disable", { token: "write-token", body: {} });
  const mina = (disabled.json.rules as { rules: Array<{ id: string; enabled: boolean; createdBy: string }> }).rules.find((rule) => rule.id === "mina");
  assert.equal(mina?.enabled, false);
  assert.equal(mina?.createdBy, "human", "disabling does not change who wrote the rule");
});

test("an agent token with rules can trash, list and undo; it cannot edit Jon's rules or auto-send", async () => {
  const t = await testApp();
  const session = await t.login();
  await t.call("/v1/rules", {
    method: "PUT",
    token: session,
    body: { rules: [{ id: "jon", name: "Jon", match: { from: ["@shop.example"] }, actions: [{ type: "label", labels: ["receipts"] }] }] },
  });
  const trash = {
    name: "Bin noise",
    match: { from: ["@news.example"] },
    actions: [{ type: "trash" }],
    why: "newsletters to trash",
  };
  assert.equal((await t.call("/v1/rules/bot-rules/noise", { method: "PUT", token: "agent-token", body: trash })).status, 403);
  assert.equal((await t.call("/v1/rules/bot-rules/noise", { method: "PUT", token: "admin-token", body: trash })).status, 403);
  assert.equal((await t.call("/v1/rules/undo", { token: "agent-rules-token", body: { why: "nothing yet" } })).status, 404);
  const saved = await t.call("/v1/rules/bot-rules/noise", { method: "PUT", token: "agent-rules-token", body: trash });
  assert.equal(saved.status, 200, saved.text);
  const rules = (saved.json.rules as { rules: Array<{ id: string; createdBy: string; enabled: boolean }> }).rules;
  assert.deepEqual(
    rules.map((rule) => [rule.id, rule.createdBy, rule.enabled]),
    [
      ["jon", "human", true],
      ["noise", "bot", true],
    ],
  );
  assert.equal((await t.call("/v1/rules/bot-rules/jon", { method: "PUT", token: "agent-rules-token", body: { ...trash, why: "take jon's" } })).status, 403);
  const live = { name: "Send", match: { from: ["a@b.example"] }, actions: [{ type: "reply", reply: { mode: "autoSend", template: "hi", allowSenders: ["a@b.example"] } }], why: "send" };
  assert.equal((await t.call("/v1/rules/bot-rules/send", { method: "PUT", token: "agent-rules-token", body: live })).status, 403);

  const pushed = await t.call("/v1/rules", {
    method: "PUT",
    token: session,
    body: { rules: [{ id: "jon", name: "Jon", match: { from: ["@shop.example"] }, actions: [{ type: "label", labels: ["home"] }] }] },
  });
  const afterPush = (pushed.json.rules as { rules: Array<{ id: string; createdBy: string }> }).rules;
  assert.deepEqual(afterPush.map((rule) => [rule.id, rule.createdBy]), [
    ["jon", "human"],
    ["noise", "bot"],
  ]);

  const undone = await t.call("/v1/rules/undo", { token: "agent-rules-token", body: { why: "too broad" } });
  assert.equal(undone.status, 200, undone.text);
  assert.deepEqual(
    (undone.json.rules as { rules: Array<{ id: string }> }).rules.map((rule) => rule.id),
    ["jon"],
  );
  const changes = await t.call("/v1/rules/changes", { token: "read-token" });
  assert.equal((changes.json.changes as unknown[]).length, 0);
  const audit = (await t.store.listAudit(30)).filter((event) => event.action === "rules.bot_upsert" || event.action === "rules.undone");
  assert.equal(audit[0]?.actor, "agent:mail");
  assert.match(audit.map((event) => event.detail).join("\n"), /why:newsletters to trash/);
  assert.match(audit.map((event) => event.detail).join("\n"), /why:too broad/);
});

test("dry run reports hits and auto-send refusals without side effects", async () => {
  const t = await testApp();
  const session = await t.login();
  const { message } = await t.ingest(fixture("personal.eml"));
  await t.call("/v1/rules", { method: "PUT", token: session, body: RULES });
  const res = await t.call("/v1/rules/test", { token: "read-token", body: { messageId: message.id } });
  assert.equal(res.status, 200);
  const outcome = res.json.outcome as { hits: Array<{ ruleId: string }>; labels: string[]; reply: { autoSendRefusals: string[] } };
  assert.deepEqual(outcome.hits.map((hit) => hit.ruleId), ["leases", "mina"]);
  assert.deepEqual(outcome.labels, ["home"]);
  assert.ok(outcome.reply.autoSendRefusals.includes("sender did not pass DMARC"));
  assert.equal(t.sender.sent.length, 0);
  assert.deepEqual((await t.store.getMessage(message.id))?.labels.includes("home"), false);
});

test("restore takes mail out of trash for any write caller; trash itself stays human-only", async () => {
  const t = await testApp();
  const session = await t.login();
  const { message } = await t.ingest(fixture("personal.eml"));
  assert.equal((await t.call(`/v1/messages/${message.id}/restore`, { token: "write-token", body: {} })).status, 400);
  assert.equal((await t.call(`/v1/messages/${message.id}/move`, { token: "write-token", body: { folder: "trash" } })).status, 403);
  assert.equal((await t.call(`/v1/messages/${message.id}/move`, { token: session, body: { folder: "trash" } })).status, 200);
  assert.equal((await t.store.getMessage(message.id))?.trashedBy, "human");
  assert.equal((await t.call(`/v1/messages/${message.id}/restore`, { token: "read-token", body: {} })).status, 403);
  const restored = await t.call(`/v1/messages/${message.id}/restore`, { token: "write-token", body: {} });
  assert.equal(restored.status, 200);
  assert.equal((await t.store.getMessage(message.id))?.folder, "inbox");
  assert.equal((await t.store.getMessage(message.id))?.trashedBy, undefined);
});
