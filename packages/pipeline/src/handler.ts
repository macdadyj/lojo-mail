import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createLlmClient, DynamoMailStore, ingestRaw, loadConfig, type EcPublicJwk, type IngestDeps, type LlmClient } from "@lojo/core";
import styleGuide from "../../../config/style-guide.md";
import { documentClient, dynamoLike, tableNamesFromEnv } from "./dynamo-doc.ts";
import { KmsKeyWrapper } from "./kms.ts";
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

const SETUP_NOTIFICATION = "AMAZON_SES_SETUP_NOTIFICATION";

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

/** Errors propagate so Lambda retries the event and then parks it in the DLQ. */
export async function handler(event: S3Notification): Promise<{ processed: number; skipped: number }> {
  const loaded = await deps.get();
  const deleteRaw = (process.env.LOJO_DELETE_RAW ?? "1") !== "0";
  let processed = 0;
  let skipped = 0;
  for (const record of event.Records ?? []) {
    const objectKey = objectKeyOf(record);
    if (!objectKey.startsWith("raw/") || objectKey.endsWith(SETUP_NOTIFICATION)) {
      skipped += 1;
      continue;
    }
    const raws = new S3BlobStore(s3, record.s3.bucket.name);
    const bytes = await raws.get(objectKey);
    if (!bytes) {
      skipped += 1;
      continue;
    }
    const blobs = new S3BlobStore(s3, loaded.bucket ?? record.s3.bucket.name);
    await ingestRaw(Buffer.from(bytes), { ...loaded, blobs }, { origin: "inbound", deliveryId: objectKey });
    if (deleteRaw) await raws.delete(objectKey);
    processed += 1;
  }
  return { processed, skipped };
}
