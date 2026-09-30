import { assertNever } from "../errors.ts";
import type { EmbedProviderName, LlmProviderName, LojoConfig } from "../types.ts";
import type { ProviderSecrets } from "./types.ts";

export type ParameterReader = (name: string) => Promise<string | undefined>;

/** Each secret comes from its env var, else from the SSM parameter named by the `_PARAM` variable. */
export const SECRET_SOURCES: Record<keyof ProviderSecrets, { env: string; param: string }> = {
  grokApiKey: { env: "LOJO_GROK_API_KEY", param: "LOJO_GROK_KEY_PARAM" },
  openaiApiKey: { env: "LOJO_OPENAI_API_KEY", param: "LOJO_OPENAI_KEY_PARAM" },
  geminiApiKey: { env: "LOJO_GEMINI_API_KEY", param: "LOJO_GEMINI_KEY_PARAM" },
  vertexServiceAccount: { env: "LOJO_VERTEX_SA_JSON", param: "LOJO_VERTEX_SA_PARAM" },
};

export function secretsFor(provider: LlmProviderName | EmbedProviderName): Array<keyof ProviderSecrets> {
  switch (provider) {
    case "grok":
      return ["grokApiKey"];
    case "openai":
      return ["openaiApiKey"];
    case "gemini":
      return ["geminiApiKey"];
    case "vertex":
      return ["vertexServiceAccount", "geminiApiKey"];
    case "bedrock":
    case "ollama":
    case "mock":
    case "none":
      return [];
    default:
      return assertNever(provider, "provider");
  }
}

/** Reads only what the selected LLM and embedder need, so an unused key is never fetched. */
export async function loadProviderSecrets(
  config: Pick<LojoConfig, "llmProvider" | "embedProvider">,
  env: NodeJS.ProcessEnv,
  read?: ParameterReader,
): Promise<ProviderSecrets> {
  const wanted = new Set([...secretsFor(config.llmProvider), ...secretsFor(config.embedProvider)]);
  const secrets: ProviderSecrets = {};
  for (const key of wanted) {
    const source = SECRET_SOURCES[key];
    const paramName = env[source.param];
    const value = env[source.env] ?? (paramName && read ? await read(paramName) : undefined);
    if (value) secrets[key] = value;
  }
  return secrets;
}
