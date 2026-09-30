import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  createEmbedder,
  createLlmClient,
  DynamoMailStore,
  ingestRaw,
  loadConfig,
  loadProviderSecrets,
  rulesRuntime,
  type EcPublicJwk,
  type Embedder,
  type IngestDeps,
  type LlmClient,
  type LojoConfig,
  type ProviderSecrets,
} from "@lojo/core";
import styleGuide from "../../../config/style-guide.md";
import { documentClient, dynamoLike, tableNamesFromEnv } from "./dynamo-doc.ts";
import { KmsKeyWrapper } from "./kms.ts";
import { isSweepEvent, processRawKey, sweepRaw, type RawDeps, type SweepEvent } from "./raw.ts";
import { S3BlobStore } from "./s3-blobs.ts";
import { SesSender } from "./ses.ts";
import { ttlCache } from "./ttl-cache.ts";

export { purge } from "./purge.ts";

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

/** A provider that cannot start (missing key, bad config) means mail is stored without it, never dropped. */
function orNull<T>(what: string, build: () => T | null): T | null {
  try {
    return build();
  } catch (error) {
    console.error(`${what} disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function providers(config: LojoConfig, secrets: ProviderSecrets): { llm: LlmClient | null; embedder: Embedder | null } {
  return {
    llm: orNull("AI analysis", () => createLlmClient(config, secrets)),
    embedder: orNull("Embeddings", () => createEmbedder(config, secrets)),
  };
}

type Deps = Omit<IngestDeps, "blobs" | "rules"> & { bucket?: string; autoSender: SesSender | null };

const deps = ttlCache<Deps>(5 * 60 * 1000, async () => {
  const raw = await parameter(process.env.LOJO_PUBLIC_KEY_PARAM ?? "/lojo-mail/envelope-public-jwk", false);
  if (!raw) throw new Error("Envelope public key parameter is missing");
  const keyId = process.env.LOJO_KMS_KEY_ID;
  const config = loadConfig();
  const secrets = await loadProviderSecrets(config, process.env, (name) => parameter(name, true));
  return {
    store: new DynamoMailStore(dynamoLike(documentClient()), tableNamesFromEnv()),
    keys: keyId ? new KmsKeyWrapper(kms, keyId) : null,
    publicJwk: JSON.parse(raw) as EcPublicJwk,
    ...providers(config, secrets),
    config,
    styleGuide: process.env.LOJO_STYLE_GUIDE ?? styleGuide,
    bucket: process.env.LOJO_BUCKET,
    // Terraform grants this role SES send only when auto_send_enabled, which is also what sets LOJO_AUTO_SEND.
    autoSender: process.env.LOJO_AUTO_SEND === "on" ? SesSender.fromEnv() : null,
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
      const { autoSender, ...ingestDeps } = loaded;
      const rules = ingestDeps.keys ? rulesRuntime(blobs, ingestDeps.keys, autoSender) : null;
      await ingestRaw(bytes, { ...ingestDeps, blobs, rules }, { origin: "inbound", deliveryId });
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
