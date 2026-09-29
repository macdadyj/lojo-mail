import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "@lojo/core/testing";
import { agentWorld } from "./test-agent.ts";
import { UNTRUSTED_PREAMBLE, callTool, tools } from "./tools.ts";

test("the tool list has no send, approve, trash, or full export", () => {
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), [
    "archive_message",
    "create_draft",
    "draft_reply",
    "export_mailbox",
    "get_action_items",
    "label_message",
    "list_inbox",
    "move_message",
    "read_thread",
    "search_mail",
    "submit_for_approval",
    "summarize_thread",
  ]);
  assert.ok(tools.every((tool) => tool.scopes.every((scope) => scope === "read" || scope === "write" || scope === "body")));
  assert.deepEqual(tools.find((tool) => tool.name === "search_mail")?.scopes, ["read"]);
  assert.deepEqual(tools.find((tool) => tool.name === "summarize_thread")?.scopes, ["write", "body"]);
  assert.deepEqual(tools.find((tool) => tool.name === "get_action_items")?.scopes, ["read", "body"]);
});

test("a write token without body cannot get message text through a thread summary", async () => {
  const w = await agentWorld(["read", "write"]);
  const { message } = await w.ingest(fixture("personal.eml"));
  await assert.rejects(() => callTool("summarize_thread", { threadId: message.threadId }, w.ctx), /Missing body scope/);
  await assert.rejects(() => callTool("get_action_items", {}, w.ctx), /Missing body scope/);
  const direct = await w.call(`/v1/threads/${message.threadId}/summarize`, { token: w.token, method: "POST" });
  assert.equal(direct.status, 403);
  assert.equal(direct.text.includes("lease"), false);
});

test("approve_and_send is an unknown tool, even with send scope", async () => {
  const w = await agentWorld(["read", "write", "send"], { unlocked: false });
  await w.ingest(fixture("personal.eml"));
  const draft = (await w.store.listDrafts())[0];
  assert.ok(draft);
  await assert.rejects(() => callTool("approve_and_send", { draftId: draft.id }, w.ctx), /Unknown tool approve_and_send/);
  assert.equal(w.sender.sent.length, 0);
});

test("an agent with send scope cannot send: it can only submit for approval", async () => {
  const w = await agentWorld(["read", "write", "send"]);
  const { message } = await w.ingest(fixture("personal.eml"));
  const created = JSON.parse(
    (await callTool("create_draft", { to: ["mina@example.com"], subject: "Re: lease", text: "Will do.", threadId: message.threadId }, w.ctx))
      .split("\n")
      .slice(2, -1)
      .join("\n"),
  ) as { draft: { id: string; origin: string } };
  assert.equal(created.draft.origin, "agent");
  const submitted = await callTool("submit_for_approval", { draftId: created.draft.id }, w.ctx);
  assert.match(submitted, /pending_approval/);
  assert.equal(w.sender.sent.length, 0);
  const denied = await w.call(`/v1/drafts/${created.draft.id}/approval`, { token: w.token, body: await w.review(created.draft.id) });
  assert.equal(denied.status, 403);
});

test("a read-only token can list and cannot draft or move", async () => {
  const w = await agentWorld(["read"]);
  const { message } = await w.ingest(fixture("personal.eml"));
  const listed = await callTool("list_inbox", { triage: true }, w.ctx);
  assert.match(listed, /Lease renewal/);
  assert.ok(listed.startsWith(UNTRUSTED_PREAMBLE));
  await assert.rejects(() => callTool("create_draft", { to: ["mina@example.com"], subject: "s", text: "t" }, w.ctx), /Missing write scope/);
  await assert.rejects(() => callTool("move_message", { messageId: message.id, folder: "archive" }, w.ctx), /Missing write scope/);
});

test("write scope can label, archive, and move to spam but not trash", async () => {
  const w = await agentWorld(["read", "write"]);
  const { message } = await w.ingest(fixture("personal.eml"));
  await callTool("label_message", { messageId: message.id, labels: ["home"] }, w.ctx);
  assert.match(await callTool("archive_message", { messageId: message.id }, w.ctx), /archive/);
  assert.match(await callTool("move_message", { messageId: message.id, folder: "inbox" }, w.ctx), /inbox/);
  await assert.rejects(() => callTool("move_message", { messageId: message.id, folder: "trash" }, w.ctx));
  assert.equal((await w.store.getMessage(message.id))?.folder, "inbox");
});

test("includeContext needs the body scope", async () => {
  const locked = await agentWorld(["read"], { unlocked: false });
  const { message } = await locked.ingest(fixture("personal.eml"));
  await assert.rejects(() => callTool("read_thread", { threadId: message.threadId, includeContext: true }, locked.ctx), /body scope/);
  const plain = await callTool("read_thread", { threadId: message.threadId }, locked.ctx);
  assert.doesNotMatch(plain, /CODEWORD-ZEBRA/);

  const body = await agentWorld(["read", "body"], { unlocked: false });
  const second = await body.ingest(fixture("personal.eml"));
  const withContext = await callTool("read_thread", { threadId: second.message.threadId, includeContext: true }, body.ctx);
  assert.match(withContext, /CODEWORD-ZEBRA/);
});
