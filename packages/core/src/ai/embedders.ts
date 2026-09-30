import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { assertNever } from "../errors.ts";
import type { LojoConfig } from "../types.ts";
import { googleEndpointFor } from "./google-endpoint.ts";
import { googleHeaders, googleModelUrl, type GoogleEndpoint } from "./google-auth.ts";
import { estimateTokens, postJson, postJsonOrThrow, trimSlash, type FetchLike } from "./http.ts";
import type { Embedder, EmbedPurpose, LlmEmbedding, ProviderSecrets } from "./types.ts";

/** Deterministic and tiny, for tests and the local demo. */
export class MockEmbedder implements Embedder {
  readonly name = "mock";
  readonly model = "mock";
  readonly dimensions = 8;
  readonly calls: Array<{ text: string; purpose: EmbedPurpose }> = [];

  async embed(text: string, purpose: EmbedPurpose): Promise<LlmEmbedding> {
    this.calls.push({ text, purpose });
    const vector = [0, 0, 0, 0, 0, 0, 0, 0];
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length; i += 1) {
      const bucket = lower.charCodeAt(i) % vector.length;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    return { vector, tokens: estimateTokens(text) };
  }
}

/** nomic-embed-text was trained with these task prefixes; other models get the text as is. */
function nomicPrefix(model: string, purpose: EmbedPurpose): string {
  if (!model.includes("nomic")) return "";
  return purpose === "query" ? "search_query: " : "search_document: ";
}

export class OllamaEmbedder implements Embedder {
  readonly name = "ollama";

  constructor(private readonly opts: { baseUrl: string; model: string; dimensions: number; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  get model(): string {
    return this.opts.model;
  }

  get dimensions(): number {
    return this.opts.dimensions;
  }

  async embed(text: string, purpose: EmbedPurpose): Promise<LlmEmbedding> {
    const base = trimSlash(this.opts.baseUrl);
    const input = `${nomicPrefix(this.opts.model, purpose)}${text}`;
    const common = {
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      timeoutMs: this.opts.timeoutMs ?? 10_000,
    };
    const modern = await postJson<{ embeddings?: number[][]; prompt_eval_count?: number }>(
      "Ollama",
      `${base}/api/embed`,
      { model: this.opts.model, input },
      common,
    );
    if (modern.ok) {
      const vector = modern.value.embeddings?.[0];
      if (!vector) throw new Error("Ollama embed response had no vector");
      return { vector, tokens: modern.value.prompt_eval_count ?? estimateTokens(input) };
    }
    if (modern.status !== 404) throw new Error(`Ollama embed failed (${modern.status})`);
    const legacy = await postJsonOrThrow<{ embedding?: number[] }>("Ollama", `${base}/api/embeddings`, { model: this.opts.model, prompt: input }, common);
    if (!legacy.embedding) throw new Error("Ollama embeddings response had no vector");
    return { vector: legacy.embedding, tokens: estimateTokens(input) };
  }
}

/** Titan Text Embeddings v2 only produces 256, 512, or 1024 dimensions. */
export const TITAN_V2_DIMENSIONS = [256, 512, 1024] as const;

export class BedrockTitanEmbedder implements Embedder {
  readonly name = "bedrock";
  private readonly client: Pick<BedrockRuntimeClient, "send">;

  constructor(private readonly opts: { region: string; modelId: string; dimensions: number; client?: Pick<BedrockRuntimeClient, "send"> }) {
    if (!(TITAN_V2_DIMENSIONS as readonly number[]).includes(opts.dimensions)) {
      throw new Error(`Titan v2 embeddings support ${TITAN_V2_DIMENSIONS.join(", ")} dimensions, not ${opts.dimensions}`);
    }
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region });
  }

  get model(): string {
    return this.opts.modelId;
  }

  get dimensions(): number {
    return this.opts.dimensions;
  }

  async embed(text: string): Promise<LlmEmbedding> {
    const output = await this.client.send(
      new InvokeModelCommand({
        modelId: this.opts.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({ inputText: text, dimensions: this.opts.dimensions, normalize: true }),
      }),
    );
    const payload = JSON.parse(new TextDecoder().decode(output.body)) as { embedding?: number[]; inputTextTokenCount?: number };
    if (!payload.embedding) throw new Error("Bedrock embedding response had no vector");
    return { vector: payload.embedding, tokens: payload.inputTextTokenCount ?? estimateTokens(text) };
  }
}

/** `/embeddings` on OpenAI or any compatible server. Vectors are truncated locally, so no `dimensions` field is sent. */
export class OpenAiCompatibleEmbedder implements Embedder {
  readonly name = "openai";

  constructor(
    private readonly opts: { apiKey?: string; baseUrl: string; model: string; dimensions: number; fetchImpl?: FetchLike; timeoutMs?: number },
  ) {}

  get model(): string {
    return this.opts.model;
  }

  get dimensions(): number {
    return this.opts.dimensions;
  }

  async embed(text: string): Promise<LlmEmbedding> {
    const payload = await postJsonOrThrow<{ data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number } }>(
      "openai",
      `${trimSlash(this.opts.baseUrl)}/embeddings`,
      { model: this.opts.model, input: text },
      {
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
      },
    );
    const vector = payload.data?.[0]?.embedding;
    if (!vector) throw new Error("openai embedding response had no vector");
    return { vector, tokens: payload.usage?.prompt_tokens ?? estimateTokens(text) };
  }
}

/** Gemini API `embedContent`, or Vertex AI `predict` (gemini-embedding-001, text-embedding-005). */
export class GoogleEmbedder implements Embedder {
  constructor(
    private readonly opts: { model: string; dimensions: number; endpoint: GoogleEndpoint; fetchImpl?: FetchLike; timeoutMs?: number },
  ) {}

  get name(): string {
    return this.opts.endpoint.kind === "studio" ? "gemini" : "vertex";
  }

  get model(): string {
    return this.opts.model;
  }

  get dimensions(): number {
    return this.opts.dimensions;
  }

  async embed(text: string, purpose: EmbedPurpose): Promise<LlmEmbedding> {
    const taskType = purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const common = {
      headers: await googleHeaders(this.opts.endpoint),
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
    };
    const dims = this.opts.dimensions > 0 ? this.opts.dimensions : undefined;
    if (this.opts.endpoint.kind === "studio") {
      const payload = await postJsonOrThrow<{ embedding?: { values?: number[] } }>(
        this.name,
        googleModelUrl(this.opts.endpoint, this.opts.model, "embedContent"),
        { content: { parts: [{ text }] }, taskType, ...(dims ? { outputDimensionality: dims } : {}) },
        common,
      );
      const vector = payload.embedding?.values;
      if (!vector) throw new Error("Gemini embedding response had no vector");
      return { vector, tokens: estimateTokens(text) };
    }
    const payload = await postJsonOrThrow<{
      predictions?: Array<{ embeddings?: { values?: number[]; statistics?: { token_count?: number } } }>;
    }>(
      this.name,
      googleModelUrl(this.opts.endpoint, this.opts.model, "predict"),
      { instances: [{ content: text, task_type: taskType }], parameters: dims ? { outputDimensionality: dims } : {} },
      common,
    );
    const embeddings = payload.predictions?.[0]?.embeddings;
    if (!embeddings?.values) throw new Error("Vertex embedding response had no vector");
    return { vector: embeddings.values, tokens: embeddings.statistics?.token_count ?? estimateTokens(text) };
  }
}

/** Returns null when embeddings are off. Semantic search then answers with a clear error. */
export function createEmbedder(config: LojoConfig, secrets: ProviderSecrets = {}, fetchImpl?: FetchLike): Embedder | null {
  const withFetch = fetchImpl ? { fetchImpl } : {};
  const dimensions = config.embedDimensions;
  switch (config.embedProvider) {
    case "none":
      return null;
    case "mock":
      return new MockEmbedder();
    case "ollama":
      return new OllamaEmbedder({ baseUrl: config.ollamaBaseUrl, model: config.ollamaEmbedModel, dimensions, ...withFetch });
    case "bedrock":
      return new BedrockTitanEmbedder({ region: config.bedrockRegion, modelId: config.bedrockEmbedModelId, dimensions });
    case "openai":
      return new OpenAiCompatibleEmbedder({
        baseUrl: config.openaiBaseUrl,
        model: config.openaiEmbedModel,
        dimensions,
        ...(secrets.openaiApiKey ? { apiKey: secrets.openaiApiKey } : {}),
        ...withFetch,
      });
    case "gemini":
    case "vertex":
      return new GoogleEmbedder({
        model: config.geminiEmbedModel,
        dimensions,
        endpoint: googleEndpointFor(config.embedProvider, config, secrets, fetchImpl),
        ...withFetch,
      });
    default:
      return assertNever(config.embedProvider, "embed provider");
  }
}
