import { assertNever } from "./errors.ts";
import type { EmbedProviderName, LlmProviderName, LojoConfig } from "./types.ts";

export const LLM_PROVIDERS: readonly LlmProviderName[] = ["grok", "bedrock", "ollama", "openai", "gemini", "vertex", "mock"];
export const EMBED_PROVIDERS: readonly EmbedProviderName[] = ["ollama", "bedrock", "openai", "gemini", "vertex", "mock", "none"];

function isProvider(value: string): value is LlmProviderName {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

function isEmbedProvider(value: string): value is EmbedProviderName {
  return (EMBED_PROVIDERS as readonly string[]).includes(value);
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

/** Local nomic-embed-text through Ollama unless the model is the mock, which pairs with the mock embedder. */
function defaultEmbedProvider(llm: LlmProviderName): EmbedProviderName {
  switch (llm) {
    case "mock":
      return "mock";
    case "grok":
    case "bedrock":
    case "ollama":
    case "openai":
    case "gemini":
    case "vertex":
      return "ollama";
    default:
      return assertNever(llm, "llm provider");
  }
}

const SEND_FROM_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** The mailbox, then each comma-separated LOJO_SEND_FROM address once. */
export function sendFromList(mailbox: string, raw: string | undefined): string[] {
  const out = [mailbox];
  for (const part of (raw ?? "").split(",")) {
    const address = part.trim().toLowerCase();
    if (!address) continue;
    if (!SEND_FROM_ADDRESS.test(address)) throw new Error(`LOJO_SEND_FROM entry ${address} is not an email address`);
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LojoConfig {
  const domain = (env.LOJO_DOMAIN ?? "cyberphysical.us").trim().toLowerCase();
  const localPart = (env.LOJO_LOCAL_PART ?? "lojo").trim().toLowerCase();
  const dmarcLocalPart = (env.LOJO_DMARC_LOCAL_PART ?? "dmarc").trim().toLowerCase();
  const providerRaw = (env.LOJO_LLM_PROVIDER ?? "grok").trim().toLowerCase();
  if (!isProvider(providerRaw)) {
    throw new Error(`LOJO_LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(", ")}`);
  }
  const provider = providerRaw;
  const embedRaw = (env.LOJO_EMBED_PROVIDER ?? defaultEmbedProvider(provider)).trim().toLowerCase();
  if (!isEmbedProvider(embedRaw)) {
    throw new Error(`LOJO_EMBED_PROVIDER must be one of ${EMBED_PROVIDERS.join(", ")}`);
  }
  const embedDimensions = intEnv(env, "LOJO_EMBED_DIMENSIONS", 256);
  if (!Number.isInteger(embedDimensions) || embedDimensions > 4096) {
    throw new Error("LOJO_EMBED_DIMENSIONS must be a whole number up to 4096 (0 keeps the model's size)");
  }
  return {
    domain,
    localPart,
    region: env.LOJO_REGION ?? "us-east-1",
    mailbox: `${localPart}@${domain}`,
    sendFrom: sendFromList(`${localPart}@${domain}`, env.LOJO_SEND_FROM),
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
    openaiBaseUrl: env.LOJO_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiModel: env.LOJO_OPENAI_MODEL ?? "gpt-4.1-nano",
    openaiEmbedModel: env.LOJO_OPENAI_EMBED_MODEL ?? "text-embedding-3-small",
    geminiModel: env.LOJO_GEMINI_MODEL ?? "gemini-2.5-flash-lite",
    geminiEmbedModel: env.LOJO_GEMINI_EMBED_MODEL ?? "gemini-embedding-001",
    vertexProject: env.LOJO_VERTEX_PROJECT ?? "",
    vertexLocation: env.LOJO_VERTEX_LOCATION ?? "us-central1",
    bedrockEmbedModelId: env.LOJO_BEDROCK_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
    embedProvider: embedRaw,
    embedDimensions,
  };
}
