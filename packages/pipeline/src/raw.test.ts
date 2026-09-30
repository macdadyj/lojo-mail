import assert from "node:assert/strict";
import test from "node:test";
import { SWEEP_EVENT, isSweepEvent, processRawKey, sweepRaw, type RawBucket, type RawDeps, type RawObject } from "./raw.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

class MemoryRaw implements RawBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; lastModified: Date }>();

  add(key: string, lastModified: Date, text = "Subject: hi\n\nbody"): void {
    this.objects.set(key, { bytes: Buffer.from(text), lastModified });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async *list(prefix: string): AsyncIterable<RawObject> {
    for (const [key, value] of [...this.objects]) {
      if (key.startsWith(prefix)) yield { key, lastModified: value.lastModified };
    }
  }
}

function recorder(fail: Set<string> = new Set()): RawDeps & { ingested: string[] } {
  const ingested: string[] = [];
  return {
    ingested,
    deleteRaw: true,
    ingest: async (_bytes, deliveryId) => {
      if (fail.has(deliveryId)) throw new Error("KMS unavailable");
      ingested.push(deliveryId);
    },
  };
}

const opts = (log: Record<string, unknown>[] = [], maxObjects = 25) => ({ now: NOW, minAgeMs: 5 * 60_000, maxObjects, log: (line: Record<string, unknown>) => log.push(line) });

test("[deploy] a message stranded in raw/ is ingested by the sweep, deleted, and logged as raw_swept", async () => {
  const bucket = new MemoryRaw();
  bucket.add("raw/stranded", minutesAgo(30));
  const deps = recorder();
  const log: Record<string, unknown>[] = [];
  const result = await sweepRaw(bucket, deps, opts(log));
  assert.deepEqual(result, { swept: 1, failed: 0, deferred: 0 });
  assert.deepEqual(deps.ingested, ["raw/stranded"]);
  assert.equal(bucket.objects.size, 0);
  assert.deepEqual(log, [{ event: "raw_swept", key: "raw/stranded", ageSeconds: 1800 }]);
});

test("[deploy] the sweep leaves fresh objects to the S3 notification and never ingests the SES setup object", async () => {
  const bucket = new MemoryRaw();
  bucket.add("raw/fresh", minutesAgo(1));
  bucket.add("raw/AMAZON_SES_SETUP_NOTIFICATION", minutesAgo(600));
  bucket.add("objects/msg_1/body", minutesAgo(600));
  const deps = recorder();
  const result = await sweepRaw(bucket, deps, opts());
  assert.deepEqual(result, { swept: 0, failed: 0, deferred: 0 });
  assert.deepEqual(deps.ingested, []);
  assert.equal(bucket.objects.size, 3);
});

test("[deploy] one failing object does not strand the others; it stays in raw/ for the next sweep", async () => {
  const bucket = new MemoryRaw();
  bucket.add("raw/a", minutesAgo(20));
  bucket.add("raw/poison", minutesAgo(20));
  bucket.add("raw/b", minutesAgo(20));
  const deps = recorder(new Set(["raw/poison"]));
  const log: Record<string, unknown>[] = [];
  const result = await sweepRaw(bucket, deps, opts(log));
  assert.deepEqual(result, { swept: 2, failed: 1, deferred: 0 });
  assert.deepEqual([...bucket.objects.keys()], ["raw/poison"]);
  assert.ok(log.some((line) => line.event === "raw_sweep_failed" && line.key === "raw/poison"));
});

test("the sweep caps work per run and reports the rest as deferred", async () => {
  const bucket = new MemoryRaw();
  for (let i = 0; i < 5; i += 1) bucket.add(`raw/m${i}`, minutesAgo(20));
  const result = await sweepRaw(bucket, recorder(), opts([], 2));
  assert.deepEqual(result, { swept: 2, failed: 0, deferred: 3 });
  assert.equal(bucket.objects.size, 3);
});

test("processing one key twice ingests once when the first run already deleted it", async () => {
  const bucket = new MemoryRaw();
  bucket.add("raw/x", minutesAgo(0));
  const deps = recorder();
  assert.equal(await processRawKey(bucket, "raw/x", deps), "processed");
  assert.equal(await processRawKey(bucket, "raw/x", deps), "skipped");
  assert.deepEqual(deps.ingested, ["raw/x"]);
});

test("only the exact scheduled input is a sweep", () => {
  assert.ok(isSweepEvent(SWEEP_EVENT));
  assert.ok(isSweepEvent({ lojo: "sweep-raw" }));
  assert.ok(!isSweepEvent({ Records: [] }));
  assert.ok(!isSweepEvent({ source: "aws.events" }));
  assert.ok(!isSweepEvent(null));
});
