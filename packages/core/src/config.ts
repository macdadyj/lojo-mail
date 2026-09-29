import { assertNever } from "./errors.ts";
import type { LlmProviderName, LojoConfig } from "./types.ts";

const PROVIDERS: readonly LlmProviderName[] = ["grok", "bedrock", "ollama", "mock"];

function isProvider(value: string): value is LlmProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LojoConfig {
  const domain = (env.LOJO_DOMAIN ?? "cyberphysical.us").trim().toLowerCase();
  const localPart = (env.LOJO_LOCAL_PART ?? "lojo").trim().toLowerCase();
  const dmarcLocalPart = (env.LOJO_DMARC_LOCAL_PART ?? "dmarc").trim().toLowerCase();
  const providerRaw = (env.LOJO_LLM_PROVIDER ?? "grok").trim().toLowerCase();
  if (!isProvider(providerRaw)) {
    throw new Error(`LOJO_LLM_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
  }
  const provider = providerRaw;
  switch (provider) {
    case "grok":
    case "bedrock":
    case "ollama":
    case "mock":
      break;
    default:
      assertNever(provider, "llm provider");
  }
  return {
    domain,
    localPart,
    region: env.LOJO_REGION ?? "us-east-1",
    mailbox: `${localPart}@${domain}`,
    dmarcMailbox: `${dmarcLocalPart}@${domain}`,
    llmProvider: provider,
    dailyTokenBudget: intEnv(env, "LOJO_DAILY_TOKEN_BUDGET", 100_000),
    maxBodyChars: intEnv(env, "LOJO_MAX_BODY_CHARS", 8_000),
    skipBulk: (env.LOJO_SKIP_BULK ?? "1") !== "0",
    snippetInClear: (env.LOJO_SNIPPET_IN_CLEAR ?? "1") !== "0",
    aiContextDays: intEnv(env, "LOJO_AI_CONTEXT_DAYS", 30),
    grokBaseUrl: env.LOJO_GROK_BASE_URL ?? "https://api.x.ai/v1",
    grokModel: env.LOJO_GROK_MODEL ?? "grok-3-mini",
    bedrockModelId: env.LOJO_BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    bedrockRegion: env.LOJO_BEDROCK_REGION ?? env.LOJO_REGION ?? "us-east-1",
    ollamaBaseUrl: env.LOJO_OLLAMA_BASE_URL ?? "http://100.96.1.90:11434",
    ollamaModel: env.LOJO_OLLAMA_MODEL ?? "llama3.2:1b",
    ollamaEmbedModel: env.LOJO_OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
  };
}
