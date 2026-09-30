export const RAW_PREFIX = "raw/";
export const SETUP_NOTIFICATION = "AMAZON_SES_SETUP_NOTIFICATION";

/** Matches the constant input of the scheduled EventBridge rule in infra/terraform/lambda.tf. */
export const SWEEP_EVENT = { lojo: "sweep-raw" } as const;
export type SweepEvent = typeof SWEEP_EVENT;

export interface RawObject {
  key: string;
  lastModified: Date;
}

export interface RawBucket {
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<RawObject>;
}

export interface RawDeps {
  ingest(bytes: Buffer, deliveryId: string): Promise<void>;
  deleteRaw: boolean;
}

export interface SweepOptions {
  now: Date;
  /** Younger objects are left to the S3 notification, which normally handles them within seconds. */
  minAgeMs: number;
  /** Keeps one sweep inside the Lambda timeout; the next run picks up the rest. */
  maxObjects: number;
  log: (line: Record<string, unknown>) => void;
}

export interface SweepResult {
  swept: number;
  failed: number;
  deferred: number;
}

export function isSweepEvent(event: unknown): event is SweepEvent {
  return typeof event === "object" && event !== null && (event as { lojo?: unknown }).lojo === SWEEP_EVENT.lojo;
}

export function isMailKey(key: string): boolean {
  return key.startsWith(RAW_PREFIX) && key.length > RAW_PREFIX.length && !key.endsWith(SETUP_NOTIFICATION);
}

/** Ingest is idempotent per raw key, so running this twice for one object stores one message. */
export async function processRawKey(bucket: RawBucket, key: string, deps: RawDeps): Promise<"processed" | "skipped"> {
  if (!isMailKey(key)) return "skipped";
  const bytes = await bucket.get(key);
  if (!bytes) return "skipped";
  await deps.ingest(Buffer.from(bytes), key);
  if (deps.deleteRaw) await bucket.delete(key);
  return "processed";
}

/**
 * Safety net for a missing or broken S3 notification: anything still under raw/ after
 * minAgeMs was not handled by the normal path. Each pickup is logged as raw_swept so an
 * alarm can say the primary trigger is broken.
 */
export async function sweepRaw(bucket: RawBucket, deps: RawDeps, opts: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { swept: 0, failed: 0, deferred: 0 };
  let attempted = 0;
  for await (const object of bucket.list(RAW_PREFIX)) {
    if (!isMailKey(object.key)) continue;
    if (opts.now.getTime() - object.lastModified.getTime() < opts.minAgeMs) continue;
    if (attempted >= opts.maxObjects) {
      result.deferred += 1;
      continue;
    }
    attempted += 1;
    try {
      if ((await processRawKey(bucket, object.key, deps)) === "processed") {
        result.swept += 1;
        opts.log({ event: "raw_swept", key: object.key, ageSeconds: Math.round((opts.now.getTime() - object.lastModified.getTime()) / 1000) });
      }
    } catch (error) {
      result.failed += 1;
      opts.log({ event: "raw_sweep_failed", key: object.key, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }
  return result;
}
