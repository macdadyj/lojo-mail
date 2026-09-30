import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "./ai/http.ts";
import type { Embedder, EmbedPurpose, LlmEmbedding } from "./ai/types.ts";
import { Mailbox } from "./mailbox.ts";
import { TEST_STYLE, fixture, malicious, memoryWorld } from "./testing.ts";

const VOCAB = ["lease", "renewal", "friday", "newsletter", "notes", "sketch", "attached", "september"];

/** One dimension per vocabulary word, so rankings in these tests are predictable. */
class KeywordEmbedder implements Embedder {
  readonly name = "keyword";
  readonly dimensions = 0;
  readonly purposes: EmbedPurpose[] = [];
  failing = false;

  constructor(readonly model = "v1") {}

  async embed(text: string, purpose: EmbedPurpose): Promise<LlmEmbedding> {
    if (this.failing) throw new Error("embedding host unreachable");
    this.purposes.push(purpose);
    const lower = text.toLowerCase();
    return { vector: VOCAB.map((word) => (lower.includes(word) ? 1 : 0)), tokens: estimateTokens(text) };
  }
}

test("semantic search ranks by the stored vectors and embeds the query as a query", async () => {
  const embedder = new KeywordEmbedder();
  const w = await memoryWorld({ embedder });
  await w.ingest(fixture("newsletter.eml"));
  await w.ingest(fixture("personal.eml"));
  await w.ingest(fixture("attachment.eml"));
  const hits = await w.mailbox.search("when is the lease renewal due", "semantic");
  assert.equal(hits[0]?.subject, "Lease renewal by Friday");
  assert.ok(hits.every((hit) => hit.subject !== "Sketch"), "zero-similarity rows are dropped");
  assert.equal(embedder.purposes.at(-1), "query");
  assert.ok(embedder.purposes.slice(0, -1).every((purpose) => purpose === "document"));
  const audit = await w.store.listAudit();
  assert.ok(audit.some((event) => event.action === "ai.embed" && event.outcome === "ok" && event.provider === "keyword"));
  assert.ok(audit.some((event) => event.action === "ai.embed_query"));
});

test("the vectors index carries only keys and the vector", async () => {
  const w = await memoryWorld();
  const { message } = await w.ingest(fixture("personal.eml"));
  const rows = await w.store.memory.query("lojo-mail-messages", { index: "vectors", keyName: "vecModel", keyValue: message.vecModel ?? "" });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), ["date", "id", "vec", "vecModel"]);
});

test("an embedding failure is audited and the mail is still stored", async () => {
  const embedder = new KeywordEmbedder();
  embedder.failing = true;
  const w = await memoryWorld({ embedder });
  const { message } = await w.ingest(fixture("personal.eml"));
  assert.equal(message.vec, undefined);
  assert.equal(message.ai?.skipped, false, "analysis is independent of embeddings");
  const audit = await w.store.listAudit();
  assert.ok(audit.some((event) => event.action === "ai.embed" && event.outcome === "error" && event.detail === "embedding host unreachable"));
});

test("PGP and quarantined mail are never embedded; a spent budget skips embedding", async () => {
  const embedder = new KeywordEmbedder();
  const w = await memoryWorld({ embedder });
  const pgp = await w.ingest(fixture("pgp.eml"));
  const quarantined = await w.ingest(
    Buffer.concat([
      Buffer.from("Authentication-Results: amazonses.com; spf=fail; dkim=fail; dmarc=fail header.from=cyberphysical.us\r\n"),
      malicious("03-spoofed-self.eml"),
    ]),
  );
  assert.equal(pgp.message.vec, undefined);
  assert.equal(quarantined.message.vec, undefined);
  assert.equal(embedder.purposes.length, 0);

  const broke = await memoryWorld({ embedder, config: { dailyTokenBudget: 0 } });
  const { message } = await broke.ingest(fixture("personal.eml"));
  assert.equal(message.vec, undefined);
  assert.ok((await broke.store.listAudit()).some((event) => event.action === "ai.embed" && event.outcome === "budget_exceeded"));
});

test("bulk mail is embedded even though the model skips it, so newsletters stay searchable", async () => {
  const embedder = new KeywordEmbedder();
  const w = await memoryWorld({ embedder });
  const { message } = await w.ingest(fixture("newsletter.eml"));
  assert.equal(message.ai?.skipReason, "bulk");
  assert.ok(message.vec);
});

test("semantic search without an embedder is a clear error", async () => {
  const w = await memoryWorld({ embedder: null });
  await w.ingest(fixture("personal.eml"));
  await assert.rejects(w.mailbox.search("lease", "semantic"), /no embedding provider/);
});

test("vectors from another model are ignored until backfilled", async () => {
  const old = new KeywordEmbedder("v1");
  const w = await memoryWorld({ embedder: old });
  const { message } = await w.ingest(fixture("personal.eml"));
  await w.ingest(fixture("pgp.eml"));

  const next = new KeywordEmbedder("v2");
  const mailbox = new Mailbox({
    store: w.store,
    blobs: w.blobs,
    keys: w.keys,
    config: w.config,
    publicJwk: w.publicJwk,
    privateJwk: w.privateJwk,
    llm: w.llm,
    embedder: next,
    styleGuide: TEST_STYLE,
  });
  assert.equal((await mailbox.search("lease renewal", "semantic")).length, 0);

  const report = await mailbox.backfillVectors(10);
  assert.deepEqual(report, { embedded: 1, unreadable: 0, failed: 0, remaining: 0 });
  assert.equal((await w.store.getMessage(message.id))?.vecModel, "keyword/v2@native");
  const hits = await mailbox.search("lease renewal", "semantic");
  assert.equal(hits[0]?.id, message.id);
});

test("backfill counts messages with no server-readable text", async () => {
  const w = await memoryWorld({ unlocked: false, embedder: new KeywordEmbedder(), config: { aiContextDays: 0 } });
  await w.ingest(fixture("personal.eml"), {}, null);
  const store = w.store;
  const [message] = await store.listMessages({ limit: 5 });
  assert.ok(message);
  await store.updateMessage(message.id, { vecModel: "stale/model@1" });
  assert.deepEqual(await w.mailbox.backfillVectors(5), { embedded: 0, unreadable: 1, failed: 0, remaining: 0 });
});
