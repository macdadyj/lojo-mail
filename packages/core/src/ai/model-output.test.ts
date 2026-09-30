import assert from "node:assert/strict";
import test from "node:test";
import { fixture, memoryWorld } from "../testing.ts";
import { MockLlm } from "./providers.ts";
import { ModelOutputError, parseAiResult } from "./schema.ts";
import type { LlmRequest } from "./types.ts";

test("prose, malformed JSON, and wrong fields are model output errors", () => {
  for (const text of ["Sure! Here is a summary.", '{"summary": "x", }', '{"summary": 1}', "{}"]) {
    assert.throws(() => parseAiResult(text), ModelOutputError, text);
  }
});

test("a non-JSON model reply at ingest stores the message, falls back, and still counts the tokens", async () => {
  const prose = new MockLlm(() => ({ text: "I think this email is about a lease.", inputTokens: 300, outputTokens: 20 }));
  const w = await memoryWorld({ llm: prose, embedder: null });
  const { message } = await w.ingest(fixture("personal.eml"));
  assert.equal(message.ai?.skipped, true);
  assert.equal(message.ai?.skipReason, "error");
  assert.equal(message.folder, "inbox");
  assert.equal(await w.store.getBudget(new Date().toISOString().slice(0, 10)), 320);
  const audit = await w.store.listAudit();
  assert.ok(audit.some((event) => event.action === "ai.analyze" && event.outcome === "error" && event.detail === "Model did not return JSON"));
});

test("draft reply falls back to a plain-text reply when the JSON analysis is unusable", async () => {
  const llm = new MockLlm((request: LlmRequest) =>
    request.system.startsWith("Write Jon's reply")
      ? { text: "Hi Mina,\n\nThanks, I will send it Thursday.\n\nJon", inputTokens: 200, outputTokens: 15 }
      : { text: "Here's what I found: the lease is due Friday.", inputTokens: 300, outputTokens: 20 },
  );
  const w = await memoryWorld({ llm });
  const { message } = await w.ingest(fixture("personal.eml"));
  const draft = await w.mailbox.draftReply(message.id);
  assert.equal(await w.mailbox.readDraftText(draft), "Hi Mina,\n\nThanks, I will send it Thursday.\n\nJon");
  assert.equal(draft.status, "suggested");
  const outcomes = (await w.store.listAudit()).filter((event) => event.action.startsWith("ai.draft_reply")).map((event) => `${event.action}:${event.outcome}`);
  assert.deepEqual(outcomes.sort(), ["ai.draft_reply:bad_output", "ai.draft_reply_fallback:ok"]);
});

test("a provider failure is a clean upstream error with the detail in the audit log", async () => {
  const down = new MockLlm(() => {
    throw new Error("connect ECONNREFUSED 10.0.0.5:443");
  });
  const w = await memoryWorld({ llm: down });
  const { message } = await w.ingest(fixture("personal.eml"));
  await assert.rejects(() => w.mailbox.draftReply(message.id), { code: "upstream", message: "The model provider did not answer. Try again later." });
  await assert.rejects(() => w.mailbox.summarizeThread(message.threadId), { code: "upstream" });
  const errors = (await w.store.listAudit()).filter((event) => event.outcome === "provider_error");
  assert.deepEqual(errors.map((event) => event.action).sort(), ["ai.draft_reply", "ai.summarize_thread"]);
  assert.match(errors[0]?.detail ?? "", /ECONNREFUSED/);
});

test("an empty fallback reply or rewrite is an upstream error, not an empty draft", async () => {
  const empty = new MockLlm(() => ({ text: "   ", inputTokens: 10, outputTokens: 0 }));
  const w = await memoryWorld({ llm: empty });
  const { message } = await w.ingest(fixture("personal.eml"));
  await assert.rejects(() => w.mailbox.draftReply(message.id), { code: "upstream" });
  assert.equal((await w.store.listDrafts()).length, 0);
  await w.store.putContact({ email: "mina@example.com" });
  const draft = await w.mailbox.createDraft({ to: ["mina@example.com"], subject: "s", text: "Keep this." });
  await assert.rejects(() => w.mailbox.rewrite(draft.id, "shorter"), { code: "upstream" });
  const stored = await w.store.getDraft(draft.id);
  assert.ok(stored);
  assert.equal(await w.mailbox.readDraftText(stored), "Keep this.");
});
