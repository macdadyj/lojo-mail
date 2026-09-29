import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MockLlm } from "./ai/providers.ts";
import { loadConfig } from "./config.ts";
import { generateIdentity, openJson } from "./crypto/envelope.ts";
import { ingestRaw } from "./ingest.ts";
import { Mailbox } from "./mailbox.ts";
import { MemorySender } from "./send.ts";
import { DynamoMailStore } from "./store/dynamo.ts";
import { MemoryStore } from "./store/memory.ts";
import type { DynamoLike, TableNames } from "./store/types.ts";
import type { LojoConfig, SealedBody } from "./types.ts";

const STYLE = "Sign off with Jon. No corporate filler.";

function fixture(name: string): Buffer {
  return readFileSync(new URL(`../../../fixtures/emails/${name}`, import.meta.url));
}

async function harness(configPatch: Partial<LojoConfig> = {}, llm?: MockLlm | null) {
  const { publicJwk, privateJwk } = await generateIdentity();
  const store = new MemoryStore();
  const config = { ...loadConfig({ LOJO_LLM_PROVIDER: "mock", LOJO_DAILY_TOKEN_BUDGET: "100000" }), ...configPatch };
  const model = llm === undefined ? new MockLlm() : llm;
  const sender = new MemorySender();
  const mailbox = new Mailbox({
    store,
    config,
    publicJwk,
    privateJwk,
    llm: model,
    sender,
    styleGuide: STYLE,
  });
  return { publicJwk, privateJwk, store, config, llm: model, sender, mailbox };
}

test("ingest seals the body, audits the call, and does not send", async () => {
  const { store, llm, sender, privateJwk, publicJwk, config } = await harness();
  const { message } = await ingestRaw(fixture("personal.eml"), {
    store,
    publicJwk,
    llm,
    config,
    styleGuide: STYLE,
  });
  const stored = JSON.stringify(message);
  assert.equal(stored.includes("CODEWORD-ZEBRA"), false);
  assert.equal(message.snippet.includes("CODEWORD-ZEBRA"), false);
  const opened = await openJson<SealedBody>(message.envelope, privateJwk);
  assert.match(opened.text, /CODEWORD-ZEBRA/);
  assert.equal(sender.sent.length, 0);
  const audit = await store.listAudit();
  assert.ok(audit.some((event) => event.action === "ai.analyze" && event.outcome === "ok"));
  assert.equal(JSON.stringify(audit).includes("CODEWORD-ZEBRA"), false);
  assert.ok(audit.every((event) => !event.detail || !event.detail.includes("Sign off with Jon")));
  assert.ok(llm);
  assert.match(llm?.calls[0]?.user ?? "", /Lease renewal/);
  assert.match(llm?.calls[0]?.system ?? "", /Sign off with Jon/);
  const drafts = await store.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.status, "suggested");
  assert.equal(drafts[0]?.aiGenerated, true);
});

test("re-ingest of the same Message-ID is a no-op", async () => {
  const env = await harness();
  const deps = {
    store: env.store,
    publicJwk: env.publicJwk,
    llm: env.llm,
    config: env.config,
    styleGuide: STYLE,
  };
  const first = await ingestRaw(fixture("personal.eml"), deps);
  const second = await ingestRaw(fixture("personal.eml"), deps);
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal((await env.store.listMessages()).length, 1);
  assert.equal(env.llm?.calls.length, 1);
});

test("bulk mail skips the model", async () => {
  const env = await harness();
  const result = await ingestRaw(fixture("newsletter.eml"), {
    store: env.store,
    publicJwk: env.publicJwk,
    llm: env.llm,
    config: env.config,
    styleGuide: STYLE,
  });
  assert.equal(result.message.bulk, true);
  assert.equal(result.message.labels.includes("bulk"), true);
  assert.equal(result.message.ai?.skipReason, "bulk");
  assert.equal(env.llm?.calls.length, 0);
  assert.equal((await env.store.listDrafts()).length, 0);
});

test("a spent token budget stores the mail and skips the model", async () => {
  const env = await harness({ dailyTokenBudget: 0 });
  const result = await ingestRaw(fixture("personal.eml"), {
    store: env.store,
    publicJwk: env.publicJwk,
    llm: env.llm,
    config: env.config,
    styleGuide: STYLE,
  });
  assert.equal(result.message.ai?.skipReason, "budget");
  assert.equal(env.llm?.calls.length, 0);
  const audit = await env.store.listAudit();
  assert.ok(audit.some((event) => event.outcome === "budget_exceeded"));
});

test("a failing model does not lose the message", async () => {
  const llm = new MockLlm(() => {
    throw new Error("model down");
  });
  const env = await harness({}, llm);
  const result = await ingestRaw(fixture("personal.eml"), {
    store: env.store,
    publicJwk: env.publicJwk,
    llm,
    config: env.config,
    styleGuide: STYLE,
  });
  assert.equal(result.message.ai?.skipReason, "error");
  assert.equal((await env.store.listMessages()).length, 1);
  const audit = JSON.stringify(await env.store.listAudit());
  assert.match(audit, /model down/);
  assert.equal(audit.includes("CODEWORD-ZEBRA"), false);
});

test("pgp mail is stored and not sent to the model", async () => {
  const env = await harness();
  const result = await ingestRaw(fixture("pgp.eml"), {
    store: env.store,
    publicJwk: env.publicJwk,
    llm: env.llm,
    config: env.config,
    styleGuide: STYLE,
  });
  assert.equal(result.message.pgpEncrypted, true);
  assert.equal(result.message.ai?.skipReason, "pgp");
  assert.equal(env.llm?.calls.length, 0);
});

test("reply lands on the parent thread and keyword search needs the key for body terms", async () => {
  const env = await harness();
  const deps = {
    store: env.store,
    publicJwk: env.publicJwk,
    llm: env.llm,
    config: env.config,
    styleGuide: STYLE,
  };
  const first = await ingestRaw(fixture("personal.eml"), deps);
  const reply = await ingestRaw(fixture("reply.eml"), deps);
  assert.equal(first.message.threadId, reply.message.threadId);
  assert.equal(reply.message.folder, "sent");

  const locked = new Mailbox({
    store: env.store,
    config: env.config,
    publicJwk: env.publicJwk,
    llm: env.llm,
    sender: env.sender,
    styleGuide: STYLE,
  });
  const sealed = await locked.listInbox();
  assert.equal(sealed[0]?.locked, true);
  assert.equal(sealed[0]?.text, undefined);
  assert.equal(sealed[0]?.envelope?.v, 1);
  const hidden = await locked.search("CODEWORD-ZEBRA");
  assert.equal(hidden.length, 0);
  const found = await env.mailbox.search("CODEWORD-ZEBRA");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.locked, false);
  assert.equal(found[0]?.envelope, undefined);
});

test("approveAndSend is the only path that touches the sender", async () => {
  const env = await harness();
  await ingestRaw(fixture("personal.eml"), {
    store: env.store,
    publicJwk: env.publicJwk,
    llm: env.llm,
    config: env.config,
    styleGuide: STYLE,
  });
  assert.equal(env.sender.sent.length, 0);
  const draft = (await env.store.listDrafts())[0];
  assert.ok(draft);
  const sent = await env.mailbox.approveAndSend(draft.id);
  assert.equal(env.sender.sent.length, 1);
  assert.match(env.sender.sent[0]?.text ?? "", /Thanks for the note/);
  assert.equal((await env.store.getDraft(draft.id))?.status, "sent");
  const audit = await env.store.listAudit();
  assert.ok(audit.some((event) => event.action === "send.approved" && event.detail === sent.messageId));
});

test("semantic search uses stored embeddings", async () => {
  const env = await harness();
  await ingestRaw(fixture("personal.eml"), {
    store: env.store,
    publicJwk: env.publicJwk,
    llm: env.llm,
    config: env.config,
    styleGuide: STYLE,
  });
  const hits = await env.mailbox.search("lease renewal", "semantic");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.subject, "Lease renewal by Friday");
});

class FakeDynamo implements DynamoLike {
  private tables = new Map<string, Map<string, Record<string, unknown>>>();

  private bag(table: string): Map<string, Record<string, unknown>> {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created = new Map<string, Record<string, unknown>>();
    this.tables.set(table, created);
    return created;
  }

  async get(table: string, key: Record<string, string>): Promise<Record<string, unknown> | null> {
    const id = Object.values(key)[0];
    if (!id) return null;
    return this.bag(table).get(id) ?? null;
  }

  async put(table: string, item: Record<string, unknown>, ifAbsentKey?: string): Promise<boolean> {
    const bag = this.bag(table);
    if (ifAbsentKey) {
      const id = String(item[ifAbsentKey]);
      if (bag.has(id)) return false;
      bag.set(id, item);
      return true;
    }
    const id = String(item.id ?? item.email ?? item.day ?? item.key);
    bag.set(id, item);
    return true;
  }

  async query(table: string, opts: { index?: string; keyName: string; keyValue: string; limit?: number; descending?: boolean }) {
    return [...this.bag(table).values()].filter((item) => item[opts.keyName] === opts.keyValue).slice(0, opts.limit ?? 100);
  }

  async scan(table: string, limit = 100) {
    return [...this.bag(table).values()].slice(0, limit);
  }

  async update(): Promise<void> {
    throw new Error("not used");
  }
}

const TABLES: TableNames = {
  messages: "messages",
  threads: "threads",
  drafts: "drafts",
  audit: "audit",
  contacts: "contacts",
  budget: "budget",
  imports: "imports",
};

test("dynamo adapter round-trips a message and import ledger", async () => {
  const store = new DynamoMailStore(new FakeDynamo(), TABLES);
  const { publicJwk, privateJwk } = await generateIdentity();
  const config = loadConfig({ LOJO_LLM_PROVIDER: "mock" });
  const { message } = await ingestRaw(fixture("html-only.eml"), {
    store,
    publicJwk,
    llm: new MockLlm(),
    config,
    styleGuide: STYLE,
  });
  const loaded = await store.getMessage(message.id);
  assert.equal(loaded?.subject, "Gate code");
  const opened = await openJson<SealedBody>(loaded!.envelope, privateJwk);
  assert.match(opened.text, /4412/);
  assert.equal(await store.markImported(message.rfcMessageId, message.id), false);
  const listed = await store.listMessages({ folder: "inbox" });
  assert.equal(listed.length, 1);
});
