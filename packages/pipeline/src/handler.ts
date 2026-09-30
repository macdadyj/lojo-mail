import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createLlmClient, DynamoMailStore, ingestRaw, loadConfig, type EcPublicJwk, type IngestDeps, type LlmClient } from "@lojo/core";
import styleGuide from "../../../config/style-guide.md";
import { documentClient, dynamoLike, tableNamesFromEnv } from "./dynamo-doc.ts";
import { KmsKeyWrapper } from "./kms.ts";
import { isSweepEvent, processRawKey, sweepRaw, type RawDeps, type SweepEvent } from "./raw.ts";
import { S3BlobStore } from "./s3-blobs.ts";
import { ttlCache } from "./ttl-cache.ts";

export interface S3Notification {
  Records?: Array<{
    s3: {
      bucket: { name: string };
      object: { key: string };
    };
  }>;
}

const s3 = new S3Client({});
const ssm = new SSMClient({});
const kms = new KMSClient({});

async function parameter(name: string, decrypt: boolean): Promise<string | undefined> {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
    return out.Parameter?.Value;
  } catch (error) {
    if (error instanceof Error && error.name === "ParameterNotFound") return undefined;
    throw error;
  }
}

async function llmOrNull(): Promise<LlmClient | null> {
  const config = loadConfig();
  if (config.llmProvider === "mock") return createLlmClient(config);
  if (config.llmProvider === "ollama" || config.llmProvider === "bedrock") {
    try {
      return createLlmClient(config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return null;
    }
  }
  const keyParam = process.env.LOJO_GROK_KEY_PARAM;
  const key = process.env.LOJO_GROK_API_KEY ?? (keyParam ? await parameter(keyParam, true) : undefined);
  if (!key) {
    console.error("Grok selected but no API key is available; storing mail without AI");
    return null;
  }
  return createLlmClient(config, { grokApiKey: key });
}

type Deps = Omit<IngestDeps, "blobs"> & { bucket?: string };

const deps = ttlCache<Deps>(5 * 60 * 1000, async () => {
  const raw = await parameter(process.env.LOJO_PUBLIC_KEY_PARAM ?? "/lojo-mail/envelope-public-jwk", false);
  if (!raw) throw new Error("Envelope public key parameter is missing");
  const keyId = process.env.LOJO_KMS_KEY_ID;
  return {
    store: new DynamoMailStore(dynamoLike(documentClient()), tableNamesFromEnv()),
    keys: keyId ? new KmsKeyWrapper(kms, keyId) : null,
    publicJwk: JSON.parse(raw) as EcPublicJwk,
    llm: await llmOrNull(),
    config: loadConfig(),
    styleGuide: process.env.LOJO_STYLE_GUIDE ?? styleGuide,
    bucket: process.env.LOJO_BUCKET,
  };
});

export function objectKeyOf(record: { s3: { object: { key: string } } }): string {
  return decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
}

const SWEEP_MIN_AGE_MS = 5 * 60 * 1000;
const SWEEP_MAX_OBJECTS = 25;

/**
 * S3 notifications carry Records. The scheduled sweep sends SWEEP_EVENT. Errors propagate
 * so Lambda retries the event and then parks it in the DLQ.
 */
export async function handler(event: S3Notification | SweepEvent): Promise<{ processed: number; skipped: number }> {
  const loaded = await deps.get();
  const deleteRaw = (process.env.LOJO_DELETE_RAW ?? "1") !== "0";
  const rawDeps = (bucket: string): RawDeps => ({
    deleteRaw,
    ingest: async (bytes, deliveryId) => {
      const blobs = new S3BlobStore(s3, loaded.bucket ?? bucket);
      await ingestRaw(bytes, { ...loaded, blobs }, { origin: "inbound", deliveryId });
    },
  });

  if (isSweepEvent(event)) {
    const bucket = loaded.bucket;
    if (!bucket) throw new Error("LOJO_BUCKET is required for the raw/ sweep");
    const result = await sweepRaw(new S3BlobStore(s3, bucket), rawDeps(bucket), {
      now: new Date(),
      minAgeMs: SWEEP_MIN_AGE_MS,
      maxObjects: SWEEP_MAX_OBJECTS,
      log: (line) => console.warn(JSON.stringify(line)),
    });
    if (result.failed > 0) throw new Error(`raw/ sweep: ${result.failed} object(s) failed to ingest`);
    return { processed: result.swept, skipped: result.deferred };
  }

  let processed = 0;
  let skipped = 0;
  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    const outcome = await processRawKey(new S3BlobStore(s3, bucket), objectKeyOf(record), rawDeps(bucket));
    if (outcome === "processed") processed += 1;
    else skipped += 1;
  }
  return { processed, skipped };
}
