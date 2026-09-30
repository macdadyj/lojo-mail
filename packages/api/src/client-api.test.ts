import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "@lojo/core/testing";
import { addBridgeToken, bridgeSendFromEnv, bridgeTrashFromEnv, hasScope, parseAgentTokens, parseScopes, TokenBook, tokenBookFromEnv } from "./auth.ts";
import { testApp } from "./test-app.ts";

test("folders list newest first with the threading metadata a mail client needs", async () => {
  const t = await testApp();
  await t.ingest(fixture("personal.eml"));
  await t.ingest(fixture("reply.eml"));
  const res = await t.call("/v1/folders/inbox/messages?limit=10", { token: "read-token" });
  assert.equal(res.status, 200);
  const messages = res.json.messages as Array<{ date: string; rfcMessageId: string; references: string[]; text?: string }>;
  assert.equal(messages.length, 2);
  assert.ok(messages[0] && messages[1] && messages[0].date > messages[1].date);
  assert.ok(messages.every((message) => message.rfcMessageId && Array.isArray(message.references)));
  assert.ok(messages.every((message) => message.text === undefined), "no body text without the body scope");
  assert.equal((await t.call("/v1/folders/nowhere/messages", { token: "read-token" })).status, 400);
});

test("read state syncs through /flags, and needs write", async () => {
  const t = await testApp();
  const { message } = await t.ingest(fixture("personal.eml"));
  assert.equal((await t.call(`/v1/messages/${message.id}/flags`, { token: "read-token", body: { unread: false } })).status, 403);
  assert.equal((await t.call(`/v1/messages/${message.id}/flags`, { token: "bridge-token", body: { unread: false } })).status, 200);
  assert.equal((await t.store.getMessage(message.id))?.unread, false);
  assert.equal((await t.store.getThread(message.threadId))?.unreadCount, 0);
  assert.equal((await t.call(`/v1/messages/${message.id}/flags`, { token: "bridge-token", body: { unread: "no" } })).status, 400);
});

test("the bridge token drafts to anyone as `client`; other tokens stay limited to known correspondents", async () => {
  const t = await testApp();
  const draft = { to: ["someone-new@example.net"], subject: "Hello", text: "Hi" };
  assert.equal((await t.call("/v1/drafts", { token: "write-token", body: draft })).status, 403);
  const res = await t.call("/v1/drafts", { token: "bridge-token", body: draft });
  assert.equal(res.status, 201);
  assert.equal((res.json.draft as { origin: string }).origin, "client");
});

test("a client draft with In-Reply-To joins the thread it answers", async () => {
  const t = await testApp();
  const { message } = await t.ingest(fixture("personal.eml"));
  const res = await t.call("/v1/drafts", {
    token: "bridge-token",
    body: { to: [message.from.email], subject: `Re: ${message.subject}`, text: "Yes.", inReplyTo: message.rfcMessageId },
  });
  const created = res.json.draft as { threadId?: string; references?: string[] };
  assert.equal(created.threadId, message.threadId);
  assert.deepEqual(created.references, [...message.references, message.rfcMessageId]);
});

test("the bridge token cannot send, mint an approval, or trash", async () => {
  const t = await testApp();
  const { message } = await t.ingest(fixture("personal.eml"));
  const created = await t.call("/v1/drafts", { token: "bridge-token", body: { to: ["a@example.net"], subject: "s", text: "t" } });
  const id = (created.json.draft as { id: string }).id;
  assert.equal((await t.call(`/v1/drafts/${id}/approval`, { token: "bridge-token", body: { to: ["a@example.net"], cc: [], subject: "s", text: "t", pgp: "auto" } })).status, 403);
  assert.equal((await t.call(`/v1/drafts/${id}/approve-and-send`, { token: "bridge-token", body: { approvalToken: "apv_x" } })).status, 403);
  assert.equal((await t.call(`/v1/messages/${message.id}/move`, { token: "bridge-token", body: { folder: "trash" } })).status, 403);
  assert.equal(t.sender.sent.length, 0);
});

test("inbound mail cannot be filed as sent or as a draft", async () => {
  const t = await testApp();
  const { message } = await t.ingest(fixture("personal.eml"));
  for (const target of ["sent", "drafts"]) {
    assert.equal((await t.call(`/v1/messages/${message.id}/move`, { token: "write-token", body: { folder: target } })).status, 400, target);
  }
  assert.equal((await t.store.getMessage(message.id))?.folder, "inbox");
});

test("production refuses a short bridge token and the dev one", () => {
  const off = { trash: false, send: false };
  assert.throws(() => addBridgeToken(new TokenBook(true), "short", true, off), /at least 32/);
  assert.throws(() => addBridgeToken(new TokenBook(true), "dev-bridge-change-me", true, off));
  const book = new TokenBook(true);
  addBridgeToken(book, "b".repeat(40), true, off);
  assert.deepEqual(book.principal(`Bearer ${"b".repeat(40)}`)?.scopes, ["read", "write", "body", "compose"]);
  addBridgeToken(book, "t".repeat(40), true, { trash: true, send: false });
  assert.deepEqual(book.principal(`Bearer ${"t".repeat(40)}`)?.scopes, ["read", "write", "body", "compose", "trash"]);
  addBridgeToken(book, "s".repeat(40), true, { trash: true, send: true });
  assert.deepEqual(book.principal(`Bearer ${"s".repeat(40)}`)?.scopes, ["read", "write", "body", "compose", "trash", "client-send"]);
  assert.equal(book.principal(`Bearer ${"s".repeat(40)}`)?.label, "bridge");
});

test("the bridge gets trash only from LOJO_BRIDGE_TRASH=on; no scope list can grant trash", () => {
  assert.equal(bridgeTrashFromEnv({}), false);
  assert.equal(bridgeTrashFromEnv({ LOJO_BRIDGE_TRASH: "true" }), false);
  assert.equal(bridgeTrashFromEnv({ LOJO_BRIDGE_TRASH: "on" }), true);
  assert.throws(() => parseScopes("read,write,trash", ["read"]), /not allowed in a scope list/);
  assert.equal(hasScope(["admin"], "trash"), false, "admin does not imply trash");
  const book = tokenBookFromEnv({ LOJO_BRIDGE_TOKEN: "x".repeat(40), LOJO_BRIDGE_TRASH: "on", LOJO_API_TOKEN: "a".repeat(40) }, true);
  assert.ok(book.principal(`Bearer ${"x".repeat(40)}`)?.scopes.includes("trash"));
  assert.ok(!book.principal(`Bearer ${"a".repeat(40)}`)?.scopes.includes("trash"));
});

test("client-send comes only from LOJO_BRIDGE_SEND=on, on the bridge token; never from a scope list, an agent token, or admin", () => {
  assert.equal(bridgeSendFromEnv({}), false);
  assert.equal(bridgeSendFromEnv({ LOJO_BRIDGE_SEND: "true" }), false);
  assert.equal(bridgeSendFromEnv({ LOJO_BRIDGE_SEND: "on" }), true);
  assert.throws(() => parseScopes("read,client-send", ["read"]), /not allowed in a scope list/);
  assert.throws(() => parseAgentTokens(JSON.stringify([{ label: "grok", token: "g".repeat(40), scopes: ["read", "client-send"] }]), true), /not allowed/);
  for (const scope of ["send", "compose", "admin"]) {
    assert.throws(() => parseAgentTokens(JSON.stringify([{ label: "grok", token: "g".repeat(40), scopes: ["read", scope] }]), true), /not allowed/, scope);
  }
  assert.equal(hasScope(["admin"], "client-send"), false, "admin does not imply client-send");
  const env = { LOJO_BRIDGE_TOKEN: "x".repeat(40), LOJO_BRIDGE_SEND: "on", LOJO_API_TOKEN: "a".repeat(40), LOJO_SEND_TOKEN: "s".repeat(40) };
  const book = tokenBookFromEnv(env, true);
  assert.ok(book.principal(`Bearer ${"x".repeat(40)}`)?.scopes.includes("client-send"));
  assert.ok(!book.principal(`Bearer ${"a".repeat(40)}`)?.scopes.includes("client-send"));
  assert.ok(!book.principal(`Bearer ${"s".repeat(40)}`)?.scopes.includes("client-send"));
});

test("agent tokens may hold trash (Jon opts in per agent) and are labelled per agent", () => {
  const [agent] = parseAgentTokens(JSON.stringify([{ label: "cursor", token: "c".repeat(40), scopes: ["read", "write", "body", "trash"] }]), true);
  assert.deepEqual(agent?.scopes, ["read", "write", "body", "trash"]);
  assert.equal(agent?.label, "agent:cursor");
});

test("the bridge with the trash scope soft-deletes: Trash with a retention window, audited, restorable", async () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const t = await testApp({ bridgeTrash: true, now: () => now });
  const { message } = await t.ingest(fixture("personal.eml"));
  const res = await t.call(`/v1/messages/${message.id}/move`, { token: "bridge-token", body: { folder: "trash" } });
  assert.equal(res.status, 200);
  const stored = await t.store.getMessage(message.id);
  assert.equal(stored?.folder, "trash");
  assert.equal(stored?.trashedBy, "bridge");
  assert.ok(stored?.keepUntil && stored.trashedAt && Date.parse(stored.keepUntil) - Date.parse(stored.trashedAt) === 30 * 86_400_000);
  const audit = (await t.store.listAudit()).filter((event) => event.action === "message.trashed");
  assert.equal(audit.length, 1);
  assert.match(audit[0]?.detail ?? "", /by:bridge from:inbox keepUntil:/);
  assert.equal((await t.call(`/v1/messages/${message.id}/move`, { token: "bridge-token", body: { folder: "inbox" } })).status, 200);
  const back = await t.store.getMessage(message.id);
  assert.equal(back?.folder, "inbox");
  assert.equal(back?.keepUntil, undefined);
  assert.ok((await t.store.listAudit()).some((event) => event.action === "message.restored"));
});

test("tokens without the trash scope cannot trash, and the bridge token cannot use MCP", async () => {
  const t = await testApp({ bridgeTrash: true, bridgeSend: true });
  const { message } = await t.ingest(fixture("personal.eml"));
  for (const token of ["write-token", "admin-token", "send-token", "agent-token"]) {
    assert.equal((await t.call(`/v1/messages/${message.id}/move`, { token, body: { folder: "trash" } })).status, 403, token);
  }
  assert.equal((await t.store.getMessage(message.id))?.folder, "inbox");
  const mcp = await t.call("/mcp", {
    token: "bridge-token",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    headers: { accept: "application/json, text/event-stream" },
  });
  assert.equal(mcp.status, 403);
});

test("a human trash also gets the retention window and an audit entry", async () => {
  const t = await testApp();
  const { message } = await t.ingest(fixture("personal.eml"));
  const session = await t.login();
  assert.equal((await t.call(`/v1/messages/${message.id}/move`, { token: session, body: { folder: "trash" } })).status, 200);
  const stored = await t.store.getMessage(message.id);
  assert.equal(stored?.trashedBy, "human");
  assert.ok(stored?.keepUntil);
  assert.ok((await t.store.listAudit()).some((event) => event.action === "message.trashed" && event.detail?.startsWith("by:human")));
});
