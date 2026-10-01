import assert from "node:assert/strict";
import test from "node:test";
import { botBodyContext, generateIdentity, LOJO_TEST_RECIPIENT, openJson, sealJson, type EnvelopeBlob } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import { testApp } from "./test-app.ts";

type App = Awaited<ReturnType<typeof testApp>>;

async function withBot(app: App, scopes?: string[]) {
  const session = await app.login();
  const created = await app.call("/v1/bots", { token: session, body: { name: "grok", ...(scopes ? { scopes } : {}) } });
  assert.equal(created.status, 201, created.text);
  return { session, token: String(created.json.token) };
}

test("only Jon's session manages bots; agent, admin, bridge and bot tokens cannot", async () => {
  const app = await testApp();
  const { token } = await withBot(app);
  for (const caller of ["admin-token", "agent-trash-token", "bridge-token", "send-token", token]) {
    assert.equal((await app.call("/v1/bots", { token: caller, body: { name: "evil" } })).status, 403, caller);
    assert.equal((await app.call("/v1/bots/grok/rotate", { token: caller, body: {} })).status, 403, caller);
    assert.equal((await app.call("/v1/bots/kill-switch", { token: caller, body: { on: false } })).status, 403, caller);
    assert.equal((await app.call("/v1/bots/envelope-key", { method: "PUT", token: caller, body: { publicJwk: {} } })).status, 403, caller);
  }
});

test("bot scopes cannot include send, compose, client-send or admin", async () => {
  const app = await testApp();
  const session = await app.login();
  for (const scope of ["send", "compose", "client-send", "admin"]) {
    const res = await app.call("/v1/bots", { token: session, body: { name: "x", scopes: ["read", scope] } });
    assert.equal(res.status, 400, scope);
  }
});

test("a bot reads, sorts and drafts, and every request is audited with actor bot:<name>", async () => {
  const app = await testApp();
  const { message } = await app.ingest(fixture("personal.eml"));
  const { token } = await withBot(app);
  const me = await app.call("/v1/session", { token });
  assert.deepEqual(me.json.label, "bot:grok");
  assert.deepEqual(me.json.scopes, ["read", "write", "body"]);

  assert.equal((await app.call("/v1/inbox", { token })).status, 200);
  assert.equal((await app.call(`/v1/messages/${message.id}/flags`, { token, body: { unread: false } })).status, 200);
  assert.equal((await app.call(`/v1/messages/${message.id}/labels`, { token, body: { labels: ["flagged"] } })).status, 200);
  const draft = await app.call("/v1/drafts", { token, body: { to: [message.from.email], subject: "Re: hi", text: "Friday works.", threadId: message.threadId } });
  assert.equal(draft.status, 201, draft.text);
  assert.equal((draft.json.draft as { origin: string }).origin, "agent");

  const audit = await app.store.listAudit(100);
  const requests = audit.filter((event) => event.action === "bot.request");
  assert.ok(requests.length >= 5);
  assert.ok(requests.every((event) => event.actor === "bot:grok"));
  assert.ok(requests.some((event) => event.detail === "POST /v1/drafts" && event.outcome === "201"));
  assert.equal(JSON.stringify(audit).includes(token), false);
  assert.equal(JSON.stringify(app.accessLog).includes(token), false);
  assert.ok(app.accessLog.some((entry) => entry.principal === "bot:grok"));
});

test("a bot never sends, approves, exports, writes Jon's rules or uses remote MCP", async () => {
  const app = await testApp();
  const { message } = await app.ingest(fixture("personal.eml"));
  const { token } = await withBot(app, ["read", "write", "body", "trash", "rules", "test-send"]);
  const draft = await app.call("/v1/drafts", { token, body: { to: [message.from.email], subject: "x", text: "y", threadId: message.threadId } });
  const id = (draft.json.draft as { id: string }).id;
  assert.equal((await app.call(`/v1/drafts/${id}/approval`, { token, body: await app.review(id) })).status, 403);
  assert.equal((await app.call(`/v1/drafts/${id}/approve-and-send`, { token, body: { approvalToken: "apv_x" } })).status, 403);
  assert.equal((await app.call("/v1/client/send", { token, body: { raw: "eA==", envelopeFrom: "lojo@cyberphysical.us", recipients: ["a@b.example"] } })).status, 403);
  assert.equal((await app.call("/v1/export", { token })).status, 403);
  assert.equal((await app.call("/v1/rules", { method: "PUT", token, body: { rules: [] } })).status, 403);
  assert.equal((await app.call("/v1/rules/switches", { token, body: { sendKillSwitch: false } })).status, 403);
  const mcp = await app.call("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(mcp.status, 403);
  assert.equal(app.sender.sent.length, 0);
});

test("rotate, revoke and the kill switch take effect on the next request", async () => {
  const app = await testApp();
  const { session, token } = await withBot(app);
  assert.equal((await app.call("/v1/inbox", { token })).status, 200);

  const rotated = await app.call("/v1/bots/grok/rotate", { token: session, body: {} });
  const next = String(rotated.json.token);
  assert.equal((await app.call("/v1/inbox", { token })).status, 401);
  assert.equal((await app.call("/v1/inbox", { token: next })).status, 200);

  await app.call("/v1/bots/kill-switch", { token: session, body: { on: true } });
  const off = await app.call("/v1/inbox", { token: next });
  assert.equal(off.status, 401);
  assert.equal(off.json.error, "Bot access is switched off");
  await app.call("/v1/bots/kill-switch", { token: session, body: { on: false } });
  assert.equal((await app.call("/v1/inbox", { token: next })).status, 200);

  await app.call("/v1/bots/grok/revoke", { token: session, body: {} });
  assert.equal((await app.call("/v1/inbox", { token: next })).status, 401);
  const listed = await app.call("/v1/bots", { token: session });
  assert.equal(JSON.stringify(listed.json).includes("tokenHash"), false);
  const events = (await app.store.listAudit(100)).map((event) => event.action);
  for (const action of ["bot.created", "bot.rotated", "bot.kill_switch", "bot.revoked"]) assert.ok(events.includes(action), action);
});

test("static tokens cannot use the bot prefix", async () => {
  const app = await testApp();
  assert.throws(() => app.tokens.add(`lbt_grok_${"x".repeat(43)}`, { label: "sneaky", scopes: ["read"] }), /reserved prefix/);
});

test("with the bot key registered, the bot fetches a copy only its key opens; Jon backfills older mail", async () => {
  const app = await testApp({ botCopies: true });
  const old = await app.ingest(fixture("personal.eml"));
  const { session, token } = await withBot(app);
  const bot = await generateIdentity();
  const key = await app.call("/v1/bots/envelope-key", { method: "PUT", token: session, body: { publicJwk: bot.publicJwk } });
  assert.equal(key.status, 200, key.text);
  const keyId = String(key.json.keyId);

  const fresh = await app.ingest(fixture("reply.eml"));
  const copy = await app.call(`/v1/messages/${fresh.message.id}/bot-copy`, { token });
  assert.equal(copy.status, 200, copy.text);
  assert.equal(copy.json.keyId, keyId);
  const opened = await openJson<{ text: string }>(copy.json.envelope as unknown as EnvelopeBlob, bot.privateJwk, botBodyContext(fresh.message.id, keyId));
  assert.ok(opened.text.length > 0);

  assert.equal((await app.call(`/v1/messages/${old.message.id}/bot-copy`, { token })).status, 404);
  const pending = await app.call("/v1/bots/backfill", { token: session });
  assert.deepEqual(pending.json.messageIds, [old.message.id]);
  const body = await app.mailbox.openMessage(old.message);
  const envelope = await sealJson({ text: body?.text ?? "", html: body?.html ?? "" }, bot.publicJwk, botBodyContext(old.message.id, keyId));
  assert.equal((await app.call(`/v1/bots/copies/${old.message.id}`, { token, body: { keyId, envelope } })).status, 403);
  assert.equal((await app.call(`/v1/bots/copies/${old.message.id}`, { token: session, body: { keyId, envelope } })).status, 200);
  assert.equal((await app.call(`/v1/messages/${old.message.id}/bot-copy`, { token })).status, 200);

  const agent = await app.call(`/v1/messages/${fresh.message.id}/bot-copy`, { token: "agent-token" });
  assert.equal(agent.status, 403);
  const reader = await withScopes(app, session, ["read"]);
  assert.equal((await app.call(`/v1/messages/${fresh.message.id}/bot-copy`, { token: reader })).status, 403);
});

async function withScopes(app: App, session: string, scopes: string[]): Promise<string> {
  const res = await app.call("/v1/bots", { token: session, body: { name: "reader", scopes } });
  return String(res.json.token);
}

test("bot rules need the rules scope and stay away from Jon's rules", async () => {
  const app = await testApp();
  const session = await app.login();
  await app.call("/v1/rules", {
    method: "PUT",
    token: session,
    body: { rules: [{ id: "jon", name: "Jon", match: { from: ["@shop.example"] }, actions: [{ type: "label", labels: ["receipts"] }] }] },
  });
  const plain = String((await app.call("/v1/bots", { token: session, body: { name: "plain" } })).json.token);
  const ruler = String((await app.call("/v1/bots", { token: session, body: { name: "ruler", scopes: ["read", "write", "rules"] } })).json.token);
  const rule = { name: "News", match: { bulk: true }, actions: [{ type: "move", folder: "archive" }] };
  assert.equal((await app.call("/v1/rules/bot-rules/news", { method: "PUT", token: plain, body: rule })).status, 403);
  assert.equal((await app.call("/v1/rules/bot-rules/news", { method: "PUT", token: "admin-token", body: rule })).status, 403);
  const saved = await app.call("/v1/rules/bot-rules/news", { method: "PUT", token: ruler, body: rule });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await app.call("/v1/rules/bot-rules/jon", { method: "PUT", token: ruler, body: rule })).status, 403);
  assert.equal((await app.call("/v1/rules/bot-rules/jon/delete", { token: ruler, body: {} })).status, 403);
  assert.equal((await app.call("/v1/rules/jon/disable", { token: ruler, body: {} })).status, 200);
  const auto = { name: "A", match: { from: ["a@b.example"] }, actions: [{ type: "reply", reply: { mode: "autoSend", template: "hi", allowSenders: ["a@b.example"] } }] };
  assert.equal((await app.call("/v1/rules/bot-rules/auto", { method: "PUT", token: ruler, body: auto })).status, 403);
  assert.equal((await app.call("/v1/rules/bot-rules/news/delete", { token: ruler, body: {} })).status, 200);
  const upserts = (await app.store.listAudit(100)).filter((event) => event.action === "rules.bot_upsert");
  assert.ok(upserts.every((event) => event.actor === "bot:ruler"));
});

test("test-send needs its scope and only ever reaches lojo-test", async () => {
  const app = await testApp();
  const session = await app.login();
  const plain = String((await app.call("/v1/bots", { token: session, body: { name: "plain" } })).json.token);
  const tester = String((await app.call("/v1/bots", { token: session, body: { name: "tester", scopes: ["read", "test-send"] } })).json.token);
  assert.equal((await app.call("/v1/bot/test-send", { token: plain, body: { subject: "s", text: "t" } })).status, 403);
  assert.equal((await app.call("/v1/bot/test-send", { token: "admin-token", body: { subject: "s", text: "t" } })).status, 403);
  const sent = await app.call("/v1/bot/test-send", { token: tester, body: { subject: "s", text: "t", to: ["jon@elsewhere.example"] } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.to, LOJO_TEST_RECIPIENT);
  assert.deepEqual(app.sender.sent.map((message) => message.to.map((item) => item.email)), [[LOJO_TEST_RECIPIENT]]);
});

test("a bot with trash moves mail to Trash as bot:<name>, restorable", async () => {
  const app = await testApp();
  const { message } = await app.ingest(fixture("personal.eml"));
  const session = await app.login();
  const noTrash = String((await app.call("/v1/bots", { token: session, body: { name: "plain" } })).json.token);
  const trasher = String((await app.call("/v1/bots", { token: session, body: { name: "sorter", scopes: ["read", "write", "trash"] } })).json.token);
  assert.equal((await app.call(`/v1/messages/${message.id}/move`, { token: noTrash, body: { folder: "trash" } })).status, 403);
  const moved = await app.call(`/v1/messages/${message.id}/move`, { token: trasher, body: { folder: "trash" } });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.trashedBy, "bot:sorter");
  assert.equal((await app.call(`/v1/messages/${message.id}/restore`, { token: trasher, body: {} })).status, 200);
});

test("a bot proposes automation disabled; only Jon enables it, by fingerprint, shadow before live", async () => {
  const app = await testApp();
  const session = await app.login();
  const ruler = String((await app.call("/v1/bots", { token: session, body: { name: "ruler", scopes: ["read", "write", "rules"] } })).json.token);
  const proposal = {
    name: "Ack receipts",
    enabled: true,
    match: { from: ["@shop.example"] },
    actions: [{ type: "reply", reply: { mode: "shadow", template: "Thanks, received.", allowSenders: ["@shop.example"] } }],
  };
  const saved = await app.call("/v1/rules/bot-rules/ack", { method: "PUT", token: ruler, body: proposal });
  assert.equal(saved.status, 200, saved.text);
  const listed = await app.call("/v1/rules", { token: session });
  const rule = (listed.json.rules as { rules: Array<{ id: string; enabled: boolean; createdBy: string }> }).rules.find((item) => item.id === "ack");
  assert.equal(rule?.enabled, false, "a proposal is always saved disabled");
  const sha256 = (listed.json.fingerprints as Record<string, string>).ack;
  assert.match(sha256 ?? "", /^[0-9a-f]{64}$/);

  assert.equal((await app.call("/v1/rules/ack/enable", { token: ruler, body: { sha256 } })).status, 403);
  assert.equal((await app.call("/v1/rules/ack/enable", { token: "admin-token", body: { sha256 } })).status, 403);
  assert.equal((await app.call("/v1/rules/ack/enable", { token: session, body: { sha256: "0".repeat(64) } })).status, 409);
  const enabled = await app.call("/v1/rules/ack/enable", { token: session, body: { sha256 } });
  assert.equal(enabled.status, 200, enabled.text);
  const after = (enabled.json.rules as { rules: Array<{ id: string; enabled: boolean; createdBy: string }> }).rules.find((item) => item.id === "ack");
  assert.deepEqual([after?.enabled, after?.createdBy], [true, "human"]);
  assert.equal((await app.call("/v1/rules/bot-rules/ack", { method: "PUT", token: ruler, body: proposal })).status, 403, "Jon's rule now");

  const fresh = String(((await app.call("/v1/rules", { token: session })).json.fingerprints as Record<string, string>).ack);
  assert.equal((await app.call("/v1/rules/ack/automation", { token: ruler, body: { mode: "live", sha256: fresh } })).status, 403);
  assert.equal((await app.call("/v1/rules/ack/automation", { token: session, body: { mode: "loud", sha256: fresh } })).status, 400);
  const live = await app.call("/v1/rules/ack/automation", { token: session, body: { mode: "live", sha256: fresh } });
  assert.equal(live.status, 200, live.text);
  assert.match(JSON.stringify(live.json), /"mode":"autoSend"/);
  const actions = (await app.store.listAudit(200)).map((event) => event.action);
  for (const action of ["rules.bot_upsert", "rules.enabled", "rules.automation"]) assert.ok(actions.includes(action), action);
});

test("the audit list takes a limit up to 500, for the digest", async () => {
  const app = await testApp();
  for (const name of ["personal.eml", "reply.eml", "newsletter.eml"]) await app.ingest(fixture(name));
  assert.ok((await app.store.listAudit(500)).length > 2);
  const res = await app.call("/v1/audit?limit=2", { token: "read-token" });
  assert.equal((res.json.events as unknown[]).length, 2);
  assert.equal((await app.call("/v1/audit?limit=99999", { token: "read-token" })).status, 200);
});
