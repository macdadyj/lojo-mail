import assert from "node:assert/strict";
import test from "node:test";
import { botCopyKey } from "../blob/store.ts";
import { generateIdentity, keyFingerprint, openJson, sealJson } from "../crypto/envelope.ts";
import { MailError } from "../errors.ts";
import { Mailbox } from "../mailbox.ts";
import { loadRules } from "../rules/engine.ts";
import { fixture, memoryWorld, type MemoryWorld } from "../testing.ts";
import { ownedBlobKeys } from "../trash/purge.ts";
import { BotAdmin } from "./admin.ts";
import { botBackfillCandidates, botBodyContext, readBotCopy, storeBotCopy, type BotBody } from "./copies.ts";
import { botNameOf, checkBotToken } from "./registry.ts";
import { LOJO_TEST_RECIPIENT } from "./test-send.ts";

function adminOf(w: MemoryWorld): BotAdmin {
  return new BotAdmin({
    store: w.store,
    publicJwk: w.publicJwk,
    now: () => new Date(),
    audit: async (action, outcome, detail) => {
      await w.store.putAudit({ id: `aud_${Math.random()}`, day: new Date().toISOString().slice(0, 10), at: new Date().toISOString(), action, outcome, detail, actor: "human" });
    },
  });
}

test("a bot token is shown once, stored as a hash, and checked against the registry", async () => {
  const w = await memoryWorld();
  const admin = adminOf(w);
  const { token, bot } = await admin.create("grok", ["read", "write", "body"]);
  assert.match(token, /^lbt_grok_[A-Za-z0-9_-]{43}$/);
  assert.equal(botNameOf(token), "grok");
  assert.equal("tokenHash" in bot, false);
  const registry = await w.store.getBotRegistry();
  assert.ok(registry);
  assert.equal(JSON.stringify(registry).includes(token), false);
  assert.deepEqual(checkBotToken(registry, token), { ok: true, bot: registry.bots[0] });
  assert.deepEqual(checkBotToken(registry, `${token.slice(0, -1)}A`), { ok: false, reason: "bad_token" });
  assert.deepEqual(checkBotToken(registry, "lbt_other_" + "x".repeat(43)), { ok: false, reason: "unknown" });
  assert.deepEqual(checkBotToken(registry, "lbt_grok_short"), { ok: false, reason: "malformed" });
  const audit = await w.store.listAudit(10);
  assert.equal(JSON.stringify(audit).includes(token), false);
  await assert.rejects(admin.create("grok", ["read"]), /already exists/);
});

test("rotate replaces the token, revoke and the kill switch refuse every request", async () => {
  const w = await memoryWorld();
  const admin = adminOf(w);
  const first = await admin.create("grok", ["read"]);
  const second = await admin.rotate("grok");
  let registry = await w.store.getBotRegistry();
  assert.equal(checkBotToken(registry, first.token).ok, false);
  assert.equal(checkBotToken(registry, second.token).ok, true);

  await admin.setKillSwitch(true);
  registry = await w.store.getBotRegistry();
  assert.deepEqual(checkBotToken(registry, second.token), { ok: false, reason: "kill_switch" });
  await admin.setKillSwitch(false);

  await admin.revoke("grok");
  registry = await w.store.getBotRegistry();
  assert.deepEqual(checkBotToken(registry, second.token), { ok: false, reason: "revoked" });
  await assert.rejects(admin.rotate("grok"), /revoked/);
  const again = await admin.create("grok", ["read"]);
  assert.equal(checkBotToken(await w.store.getBotRegistry(), again.token).ok, true);
});

test("a stale registry save loses instead of overwriting", async () => {
  const w = await memoryWorld();
  await adminOf(w).create("grok", ["read"]);
  const stored = await w.store.getBotRegistry();
  assert.ok(stored);
  assert.equal(await w.store.saveBotRegistry({ ...stored, version: stored.version + 1 }, stored.version - 1), false);
  assert.equal(await w.store.saveBotRegistry({ ...stored, version: stored.version + 1 }, stored.version), true);
});

test("the bot envelope key must be a public key and not Jon's", async () => {
  const w = await memoryWorld();
  const admin = adminOf(w);
  const bot = await generateIdentity();
  await assert.rejects(admin.setEnvelopeKey(bot.privateJwk), /private key/);
  await assert.rejects(admin.setEnvelopeKey(w.publicJwk), /Jon's envelope key/);
  const key = await admin.setEnvelopeKey(bot.publicJwk);
  assert.equal(key.keyId, await keyFingerprint(bot.publicJwk));
});

test("with a bot key registered, new mail gets a copy only the bot key opens; the purge owns it", async () => {
  const w = await memoryWorld({ botCopies: true });
  const before = await w.ingest(fixture("personal.eml"));
  assert.equal(before.message.botBodyKey, undefined);

  const bot = await generateIdentity();
  const key = await adminOf(w).setEnvelopeKey(bot.publicJwk);
  const { message } = await w.ingest(fixture("reply.eml"));
  assert.equal(message.botKeyId, key.keyId);
  assert.equal(message.botBodyKey, botCopyKey(message.id, key.keyId));

  const copy = await readBotCopy(w.store, w.blobs, message.id);
  const opened = await openJson<BotBody>(copy.envelope, bot.privateJwk, botBodyContext(message.id, key.keyId));
  assert.ok(opened.text.length > 0);
  assert.deepEqual(Object.keys(opened).sort(), ["html", "text"]);
  await assert.rejects(openJson(copy.envelope, w.privateJwk, botBodyContext(message.id, key.keyId)));
  await assert.rejects(openJson(copy.envelope, bot.privateJwk, botBodyContext(before.message.id, key.keyId)));

  const stored = await w.store.getMessage(message.id);
  assert.ok(stored);
  assert.ok(ownedBlobKeys(stored).includes(botCopyKey(message.id, key.keyId)));
  assert.equal(ownedBlobKeys({ ...stored, botBodyKey: `objects/${before.message.id}.bin` }).includes(`objects/${before.message.id}.bin`), false);

  await assert.rejects(readBotCopy(w.store, w.blobs, before.message.id), /no copy for the current bot key/);
});

test("removing or replacing the bot key cuts off old copies", async () => {
  const w = await memoryWorld({ botCopies: true });
  const admin = adminOf(w);
  await admin.setEnvelopeKey((await generateIdentity()).publicJwk);
  const { message } = await w.ingest(fixture("personal.eml"));
  await readBotCopy(w.store, w.blobs, message.id);
  await admin.setEnvelopeKey((await generateIdentity()).publicJwk);
  await assert.rejects(readBotCopy(w.store, w.blobs, message.id), /no copy for the current bot key/);
  await admin.removeEnvelopeKey();
  await assert.rejects(readBotCopy(w.store, w.blobs, message.id), /No bot envelope key/);
  const next = await w.ingest(fixture("reply.eml"));
  assert.equal(next.message.botBodyKey, undefined);
});

test("backfill: Jon re-seals older mail for the current key", async () => {
  const w = await memoryWorld({ botCopies: true });
  const old = await w.ingest(fixture("personal.eml"));
  const bot = await generateIdentity();
  const key = await adminOf(w).setEnvelopeKey(bot.publicJwk);
  const candidates = await botBackfillCandidates(w.store, 10);
  assert.deepEqual(candidates, { keyId: key.keyId, messageIds: [old.message.id] });

  const body = (await w.mailbox.openMessage(old.message)) ?? { text: "", html: "" };
  const sealed = await sealJson({ text: body.text, html: body.html }, bot.publicJwk, botBodyContext(old.message.id, key.keyId));
  await assert.rejects(storeBotCopy(w.store, w.blobs, old.message.id, "other", sealed), /current bot key/);
  await assert.rejects(storeBotCopy(w.store, w.blobs, old.message.id, key.keyId, { v: 1 }), /lojo envelope/);
  await storeBotCopy(w.store, w.blobs, old.message.id, key.keyId, sealed);
  const copy = await readBotCopy(w.store, w.blobs, old.message.id);
  assert.equal((await openJson<BotBody>(copy.envelope, bot.privateJwk, botBodyContext(old.message.id, key.keyId))).text, body.text);
  assert.deepEqual((await botBackfillCandidates(w.store, 10)).messageIds, []);
});

test("bot rules: add, edit and delete their own; never Jon's, never auto-send or trash", async () => {
  const w = await memoryWorld();
  await w.mailbox.putRules(
    { rules: [{ id: "jon-receipts", name: "Receipts", match: { from: ["@shop.example"] }, actions: [{ type: "label", labels: ["receipts"] }] }] },
    "human",
  );
  const doc = await w.mailbox.putBotRule({ id: "news", name: "Newsletters", match: { bulk: true }, actions: [{ type: "move", folder: "archive" }] });
  assert.equal(doc.rules.find((rule) => rule.id === "news")?.createdBy, "bot");
  assert.equal(doc.rules.find((rule) => rule.id === "jon-receipts")?.createdBy, "human");

  await w.mailbox.putBotRule({ id: "news", name: "Newsletters", match: { bulk: true }, actions: [{ type: "label", labels: ["news"] }] });
  const saved = await loadRules(w.blobs, w.keys);
  assert.deepEqual(saved?.rules.find((rule) => rule.id === "news")?.actions, [{ type: "label", labels: ["news"] }]);

  await assert.rejects(w.mailbox.putBotRule({ id: "jon-receipts", name: "x", match: { bulk: true }, actions: [{ type: "markRead" }] }), /is Jon's/);
  await assert.rejects(w.mailbox.deleteBotRule("jon-receipts"), /is Jon's/);
  await assert.rejects(w.mailbox.putBotRule({ id: "bin", name: "Bin", match: { bulk: true }, actions: [{ type: "trash" }] }), /cannot move mail to Trash/);
  await assert.rejects(
    w.mailbox.putBotRule({
      id: "auto",
      name: "Auto",
      match: { from: ["a@b.example"] },
      actions: [{ type: "reply", reply: { mode: "autoSend", template: "hi", allowSenders: ["a@b.example"] } }],
    }),
    /cannot auto-send/,
  );
  await assert.rejects(w.mailbox.putBotRule({ id: "x", name: "x", match: {}, actions: [{ type: "markRead" }] }), MailError);

  const after = await w.mailbox.deleteBotRule("news");
  assert.deepEqual(after.rules.map((rule) => rule.id), ["jon-receipts"]);
});

test("a bot rule cannot touch the switches or limits", async () => {
  const w = await memoryWorld();
  await w.mailbox.setRuleSwitches({ killSwitch: true, sendKillSwitch: true }, "agent");
  const doc = await w.mailbox.putBotRule({ id: "n", name: "n", match: { bulk: true }, actions: [{ type: "markRead" }] });
  assert.equal(doc.killSwitch, true);
  assert.equal(doc.sendKillSwitch, true);
});

test("test-send goes only to lojo-test, honours the send kill switch and is rate limited", async () => {
  let now = new Date("2026-10-01T10:00:00Z");
  const w = await memoryWorld({ now: () => now, deps: {} });
  const sent = await w.mailbox.botTestSend({ bot: "bot:grok", subject: "hello", text: "checking the pipe" });
  assert.equal(sent.to, LOJO_TEST_RECIPIENT);
  assert.equal(w.sender.sent.length, 1);
  const out = w.sender.sent[0];
  assert.deepEqual(out?.to, [{ email: LOJO_TEST_RECIPIENT }]);
  assert.deepEqual(out?.cc, []);
  assert.equal(out?.subject, "[lojo-bot test] hello");
  assert.equal(out?.autoReplied, true);
  const copies = await w.store.listMessages({ folder: "sent" });
  assert.equal(copies.length, 1);

  for (let i = 0; i < 4; i += 1) await w.mailbox.botTestSend({ bot: "bot:grok", subject: `n${i}`, text: "x" });
  await assert.rejects(w.mailbox.botTestSend({ bot: "bot:grok", subject: "6th", text: "x" }), /limited/);
  now = new Date("2026-10-01T12:00:00Z");
  await w.mailbox.botTestSend({ bot: "bot:grok", subject: "next hour", text: "x" });

  await w.mailbox.setRuleSwitches({ sendKillSwitch: true }, "agent");
  await assert.rejects(w.mailbox.botTestSend({ bot: "bot:grok", subject: "stopped", text: "x" }), /kill switch/);
  const audit = (await w.store.listAudit(100)).filter((event) => event.action === "bot.test_send");
  assert.ok(audit.every((event) => event.actor === "bot:grok"));
  assert.deepEqual([...new Set(audit.map((event) => event.outcome))].sort(), ["kill_switch", "rate_limited", "sent"]);
});

test("bots share the agent trash cap and are named in trashedBy", async () => {
  const w = await memoryWorld({ deps: { agentTrashPerDay: 1 } });
  const a = await w.ingest(fixture("personal.eml"));
  const b = await w.ingest(fixture("reply.eml"));
  const trashed = await w.mailbox.trash(a.message.id, "bot:grok");
  assert.equal(trashed.trashedBy, "bot:grok");
  await assert.rejects(w.mailbox.trash(b.message.id, "bot:grok"), /daily limit/);
});

test("audit events carry the request's actor", async () => {
  const w = await memoryWorld();
  let actor: string | undefined = "bot:grok";
  const mailbox = new Mailbox({
    store: w.store,
    blobs: w.blobs,
    keys: w.keys,
    config: w.config,
    publicJwk: w.publicJwk,
    styleGuide: "",
    auditActor: () => actor,
  });
  await mailbox.setRuleSwitches({ paused: true }, "agent");
  actor = undefined;
  await mailbox.setRuleSwitches({ killSwitch: true }, "agent");
  const events = (await w.store.listAudit(10)).filter((event) => event.action === "rules.switches");
  assert.deepEqual(events.map((event) => event.actor ?? null).sort(), ["bot:grok", null]);
});
