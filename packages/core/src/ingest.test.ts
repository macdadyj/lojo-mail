import assert from "node:assert/strict";
import test from "node:test";
import { MockLlm } from "./ai/providers.ts";
import { MemoryBlobStore } from "./blob/store.ts";
import { loadConfig } from "./config.ts";
import { decodeEnvelope, generateIdentity, messageBodyContext, openJson } from "./crypto/envelope.ts";
import { ingestRaw, messageIdFor } from "./ingest.ts";
import { DynamoMailStore } from "./store/dynamo.ts";
import { MemoryDynamo } from "./store/memory-dynamo.ts";
import type { TableNames } from "./store/types.ts";
import { TEST_STYLE, fixture, memoryWorld } from "./testing.ts";
import type { SealedBody } from "./types.ts";

test("ingest seals the body to S3, audits the call, and does not send", async () => {
  const w = await memoryWorld();
  const { message } = await w.ingest(fixture("personal.eml"));
  assert.equal(JSON.stringify(message).includes("CODEWORD-ZEBRA"), false);
  assert.equal(message.snippet.includes("CODEWORD-ZEBRA"), false);
  assert.equal(message.bodyKey, `objects/${message.id}.bin`);
  const bytes = await w.blobs.get(message.bodyKey);
  assert.ok(bytes);
  assert.equal(new TextDecoder().decode(bytes).includes("CODEWORD-ZEBRA"), false);
  const opened = await openJson<SealedBody>(decodeEnvelope(bytes), w.privateJwk, messageBodyContext(message.id));
  assert.match(opened.text, /CODEWORD-ZEBRA/);
  assert.equal(w.sender.sent.length, 0);
  const audit = await w.store.listAudit();
  assert.ok(audit.some((event) => event.action === "ai.analyze" && event.outcome === "ok"));
  assert.equal(JSON.stringify(audit).includes("CODEWORD-ZEBRA"), false);
  assert.match(w.llm?.calls[0]?.user ?? "", /Lease renewal/);
  assert.match(w.llm?.calls[0]?.system ?? "", /Sign off with Jon/);
  const drafts = await w.store.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.status, "suggested");
  assert.equal(drafts[0]?.origin, "ai");
  assert.equal(JSON.stringify(drafts[0]).includes("Thanks for the note"), false);
});

test("redelivery of the same S3 object is a no-op", async () => {
  const w = await memoryWorld();
  const first = await w.ingest(fixture("personal.eml"), { deliveryId: "raw/abc" });
  const second = await w.ingest(fixture("personal.eml"), { deliveryId: "raw/abc" });
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(first.message.id, messageIdFor("raw/abc"));
  assert.equal((await w.store.listMessages()).length, 1);
  assert.equal(w.llm?.calls.length, 1);
});

test("bulk mail skips the model", async () => {
  const w = await memoryWorld();
  const result = await w.ingest(fixture("newsletter.eml"));
  assert.equal(result.message.bulk, true);
  assert.equal(result.message.labels.includes("bulk"), true);
  assert.equal(result.message.ai?.skipReason, "bulk");
  assert.equal(result.message.aiContextKey, undefined);
  assert.equal(w.llm?.calls.length, 0);
  assert.equal((await w.store.listDrafts()).length, 0);
});

test("a spent token budget stores the mail and skips the model", async () => {
  const w = await memoryWorld({ config: { dailyTokenBudget: 0 } });
  const result = await w.ingest(fixture("personal.eml"));
  assert.equal(result.message.ai?.skipReason, "budget");
  assert.equal(w.llm?.calls.length, 0);
  assert.ok((await w.store.listAudit()).some((event) => event.outcome === "budget_exceeded"));
});

test("a failing model does not lose the message", async () => {
  const llm = new MockLlm(() => {
    throw new Error("model down");
  });
  const w = await memoryWorld({ llm });
  const result = await w.ingest(fixture("personal.eml"));
  assert.equal(result.message.ai?.skipReason, "error");
  assert.equal((await w.store.listMessages()).length, 1);
  const audit = JSON.stringify(await w.store.listAudit());
  assert.match(audit, /model down/);
  assert.equal(audit.includes("CODEWORD-ZEBRA"), false);
});

test("pgp mail is stored, not sent to the model, and gets no AI-context copy", async () => {
  const w = await memoryWorld();
  const result = await w.ingest(fixture("pgp.eml"));
  assert.equal(result.message.pgpEncrypted, true);
  assert.equal(result.message.ai?.skipReason, "pgp");
  assert.equal(result.message.aiContextKey, undefined);
  assert.equal(w.llm?.calls.length, 0);
});

test("the AI-context copy is sealed and can be turned off", async () => {
  const on = await memoryWorld();
  const { message } = await on.ingest(fixture("personal.eml"));
  assert.equal(message.aiContextKey, `ai-context/${message.id}.bin`);
  const raw = await on.blobs.get(message.aiContextKey ?? "");
  assert.ok(raw);
  assert.equal(new TextDecoder().decode(raw).includes("CODEWORD-ZEBRA"), false);
  assert.match((await on.mailbox.contextText(message)) ?? "", /CODEWORD-ZEBRA/);

  const off = await memoryWorld({ config: { aiContextDays: 0 } });
  const second = await off.ingest(fixture("personal.eml"));
  assert.equal(second.message.aiContextKey, undefined);
});

test("Jon's sent copy joins the thread and keyword search needs the key for body terms", async () => {
  const w = await memoryWorld();
  const first = await w.ingest(fixture("personal.eml"));
  const reply = await w.ingest(fixture("reply.eml"), { origin: "sent" });
  assert.equal(first.message.threadId, reply.message.threadId);
  assert.equal(reply.message.folder, "sent");
  assert.equal(reply.message.ai?.skipReason, "sent");

  const locked = await memoryWorld({ unlocked: false });
  await locked.ingest(fixture("personal.eml"));
  const sealed = await locked.mailbox.listInbox();
  assert.equal(sealed[0]?.locked, true);
  assert.equal(sealed[0]?.text, undefined);
  assert.equal((await locked.mailbox.search("CODEWORD-ZEBRA")).length, 0);
  assert.equal((await w.mailbox.search("CODEWORD-ZEBRA")).length, 0, "body terms need withBody");
  const found = await w.mailbox.search("CODEWORD-ZEBRA", "keyword", { withBody: true });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.locked, false);
});

test("semantic search uses stored embeddings", async () => {
  const w = await memoryWorld();
  await w.ingest(fixture("personal.eml"));
  const hits = await w.mailbox.search("lease renewal", "semantic");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.subject, "Lease renewal by Friday");
});

const TABLES: TableNames = {
  messages: "t-messages",
  threads: "t-threads",
  drafts: "t-drafts",
  audit: "t-audit",
  contacts: "t-contacts",
  budget: "t-budget",
};

test("the DynamoDB store round-trips a message through the declared indexes", async () => {
  const store = new DynamoMailStore(new MemoryDynamo(TABLES), TABLES);
  const blobs = new MemoryBlobStore();
  const { publicJwk, privateJwk } = await generateIdentity();
  const config = loadConfig({ LOJO_LLM_PROVIDER: "mock" });
  const deps = { store, blobs, publicJwk, llm: new MockLlm(), config, styleGuide: TEST_STYLE };
  const { message } = await ingestRaw(fixture("html-only.eml"), deps, { deliveryId: "raw/1" });
  const loaded = await store.getMessage(message.id);
  assert.equal(loaded?.subject, "Gate code");
  const bytes = await blobs.get(loaded?.bodyKey ?? "");
  assert.ok(bytes);
  const opened = await openJson<SealedBody>(decodeEnvelope(bytes), privateJwk, messageBodyContext(message.id));
  assert.match(opened.text, /4412/);
  assert.equal((await ingestRaw(fixture("html-only.eml"), deps, { deliveryId: "raw/1" })).duplicate, true);
  assert.equal((await store.listMessages({ folder: "inbox" })).length, 1);
  assert.equal((await store.getMessagesByRfcId(message.rfcMessageId)).length, 1);
  assert.equal((await store.listThreadMessages(message.threadId)).length, 1);
  assert.equal((await store.listThreads()).length, 1);
});

test("budget is an atomic ADD", async () => {
  const w = await memoryWorld();
  await Promise.all([w.store.addBudget("2026-09-29", 10), w.store.addBudget("2026-09-29", 5)]);
  assert.equal(await w.store.getBudget("2026-09-29"), 15);
});
