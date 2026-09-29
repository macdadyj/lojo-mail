import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createLlmClient, DynamoMailStore, ingestRaw, loadConfig, type EcPublicJwk, type LlmClient } from "@lojo/core";
import styleGuide from "../../../config/style-guide.md";
import { documentClient, dynamoLike, tableNamesFromEnv } from "./dynamo-doc.ts";

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

async function parameter(name: string | undefined, decrypt: boolean): Promise<string | undefined> {
  if (!name) return undefined;
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
    return out.Parameter?.Value;
  } catch (error) {
    const message = error instanceof Error ? error.name : "error";
    console.error(`ssm read failed for ${name}: ${message}`);
    return undefined;
  }
}

async function publicKey(): Promise<EcPublicJwk> {
  const raw = await parameter(process.env.LOJO_PUBLIC_KEY_PARAM ?? "/lojo-mail/envelope-public-jwk", false);
  if (!raw) throw new Error("Envelope public key parameter is missing");
  return JSON.parse(raw) as EcPublicJwk;
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
  const key = process.env.LOJO_GROK_API_KEY ?? (await parameter(process.env.LOJO_GROK_KEY_PARAM, true));
  if (!key) {
    console.error("Grok selected but no API key is available; storing mail without AI");
    return null;
  }
  return createLlmClient(config, { grokApiKey: key });
}

export async function handler(event: S3Notification): Promise<{ processed: number }> {
  const config = loadConfig();
  const store = new DynamoMailStore(dynamoLike(documentClient()), tableNamesFromEnv());
  const key = await publicKey();
  const llm = await llmOrNull();
  let processed = 0;
  for (const record of event.Records ?? []) {
    const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    if (!objectKey.startsWith("raw/")) continue;
    const object = await s3.send(new GetObjectCommand({ Bucket: record.s3.bucket.name, Key: objectKey }));
    const bytes = await object.Body?.transformToByteArray();
    if (!bytes) continue;
    await ingestRaw(Buffer.from(bytes), {
      store,
      publicJwk: key,
      llm,
      config,
      styleGuide: process.env.LOJO_STYLE_GUIDE ?? styleGuide,
    });
    processed += 1;
  }
  return { processed };
}
