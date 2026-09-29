import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateIdentity, ingestRaw, loadConfig, Mailbox, MemorySender, MemoryStore, MockLlm } from "@lojo/core";
import { callTool, tools } from "./tools.ts";

async function ctx(scopes: Array<"read" | "write" | "send" | "admin">) {
  const { publicJwk, privateJwk } = await generateIdentity();
  const store = new MemoryStore();
  const config = loadConfig({ LOJO_LLM_PROVIDER: "mock" });
  const llm = new MockLlm();
  const sender = new MemorySender();
  const mailbox = new Mailbox({ store, config, publicJwk, privateJwk, llm, sender, styleGuide: "Sign off with Jon." });
  const raw = readFileSync(new URL("../../../fixtures/emails/personal.eml", import.meta.url));
  await ingestRaw(raw, { store, publicJwk, llm, config, styleGuide: "Sign off with Jon." });
  return { mailbox, scopes, sender, store };
}

test("the tool list covers the mailbox surface", () => {
  const names = tools.map((tool) => tool.name);
  for (const name of [
    "search_mail",
    "read_thread",
    "list_inbox",
    "summarize_thread",
    "draft_reply",
    "create_draft",
    "approve_and_send",
    "label_message",
    "archive_message",
    "move_message",
    "get_action_items",
    "export_mailbox",
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(tools.find((tool) => tool.name === "approve_and_send")?.scope, "send");
  assert.equal(tools.find((tool) => tool.name === "list_inbox")?.scope, "read");
});

test("a read-only token can search and cannot send", async () => {
  const context = await ctx(["read"]);
  const listed = await callTool("list_inbox", { triage: true }, context);
  assert.match(listed, /Lease renewal/);
  await assert.rejects(() => callTool("approve_and_send", { draftId: "nope" }, context), /Missing send scope/);
  assert.equal(context.sender.sent.length, 0);
});

test("send scope delivers a draft exactly once", async () => {
  const context = await ctx(["send"]);
  const draft = (await context.store.listDrafts())[0];
  assert.ok(draft);
  const sent = await callTool("approve_and_send", { draftId: draft.id }, context);
  assert.match(sent, /messageId/);
  assert.equal(context.sender.sent.length, 1);
});

test("write scope can label and archive", async () => {
  const context = await ctx(["write", "read"]);
  const message = (await context.store.listMessages())[0];
  assert.ok(message);
  await callTool("label_message", { messageId: message.id, labels: ["home"] }, context);
  const archived = await callTool("archive_message", { messageId: message.id }, context);
  assert.match(archived, /archive/);
  const items = await callTool("get_action_items", {}, context);
  assert.equal(items.startsWith("[") || items.startsWith("{") || items === "[]", true);
});
