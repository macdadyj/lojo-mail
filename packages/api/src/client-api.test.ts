import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "@lojo/core/testing";
import { addBridgeToken, TokenBook } from "./auth.ts";
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
  assert.throws(() => addBridgeToken(new TokenBook(true), "short", true), /at least 32/);
  assert.throws(() => addBridgeToken(new TokenBook(true), "dev-bridge-change-me", true));
  const book = new TokenBook(true);
  addBridgeToken(book, "b".repeat(40), true);
  assert.deepEqual(book.principal(`Bearer ${"b".repeat(40)}`)?.scopes, ["read", "write", "body", "compose"]);
});
