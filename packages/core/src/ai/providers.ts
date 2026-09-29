import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { assertNever } from "../errors.ts";
import type { LojoConfig } from "../types.ts";
import type { LlmClient, LlmCompletion, LlmEmbedding, LlmRequest } from "./types.ts";

type FetchLike = typeof fetch;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockLlm implements LlmClient {
  readonly name = "mock";
  readonly model = "mock";
  readonly calls: LlmRequest[] = [];

  constructor(private readonly script?: (request: LlmRequest) => LlmCompletion | Promise<LlmCompletion>) {}

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.calls.push(request);
    if (this.script) return this.script(request);
    const haystack = request.user.toLowerCase();
    const phishing = /verify your account|password expires|suspended/.test(haystack);
    const newsletter = /unsubscribe|newsletter/.test(haystack);
    const body = {
      summary: phishing ? "Possible credential phish." : newsletter ? "Newsletter; no action." : "Personal note that needs a reply.",
      category: phishing ? "phishing" : newsletter ? "newsletter" : "personal",
      priority: phishing ? "now" : newsletter ? "noise" : "today",
      actionItems: phishing || newsletter ? [] : [{ text: "Reply", deadline: null }],
      labels: phishing ? ["phish"] : newsletter ? ["lists"] : ["personal"],
      phishingScore: phishing ? 90 : 5,
      phishingReasons: phishing ? ["Mock model flagged credential language"] : [],
      unsubscribe: { detected: newsletter, url: newsletter ? "https://example.com/unsub" : null, mailto: null },
      threadSummary: "Mock thread summary.",
      draftReply: phishing ? "" : "Hi,\n\nThanks for the note. I will follow up.\n\nJon",
    };
    return {
      text: JSON.stringify(body),
      inputTokens: estimateTokens(request.system + request.user),
      outputTokens: estimateTokens(JSON.stringify(body)),
    };
  }

  async embed(text: string): Promise<LlmEmbedding> {
    const vector = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < text.length; i += 1) {
      const bucket = i % vector.length;
      const current = vector[bucket] ?? 0;
      vector[bucket] = current + text.charCodeAt(i) / 255;
    }
    return { vector, tokens: estimateTokens(text) };
  }
}

export class GrokLlm implements LlmClient {
  readonly name = "grok";

  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; model: string; fetchImpl?: FetchLike },
  ) {}

  get model(): string {
    return this.opts.model;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Grok request failed (${response.status})`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content ?? "";
    return {
      text,
      inputTokens: payload.usage?.prompt_tokens ?? estimateTokens(request.user),
      outputTokens: payload.usage?.completion_tokens ?? estimateTokens(text),
    };
  }
}

export class OllamaLlm implements LlmClient {
  readonly name = "ollama";

  constructor(
    private readonly opts: { baseUrl: string; model: string; embedModel: string; fetchImpl?: FetchLike },
  ) {}

  get model(): string {
    return this.opts.model;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        stream: false,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        options: { temperature: request.temperature ?? 0.2, num_predict: request.maxTokens },
      }),
    });
    if (!response.ok) throw new Error(`Ollama request failed (${response.status})`);
    const payload = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = payload.message?.content ?? "";
    return {
      text,
      inputTokens: payload.prompt_eval_count ?? estimateTokens(request.user),
      outputTokens: payload.eval_count ?? estimateTokens(text),
    };
  }

  async embed(text: string): Promise<LlmEmbedding> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const base = this.opts.baseUrl.replace(/\/$/, "");
    const modern = await fetchImpl(`${base}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.opts.embedModel, input: text }),
    });
    if (modern.ok) {
      const payload = (await modern.json()) as { embeddings?: number[][] };
      const vector = payload.embeddings?.[0];
      if (!vector) throw new Error("Ollama embed response had no vector");
      return { vector, tokens: estimateTokens(text) };
    }
    const legacy = await fetchImpl(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.opts.embedModel, prompt: text }),
    });
    if (!legacy.ok) throw new Error(`Ollama embed failed (${legacy.status})`);
    const payload = (await legacy.json()) as { embedding?: number[] };
    if (!payload.embedding) throw new Error("Ollama embeddings response had no vector");
    return { vector: payload.embedding, tokens: estimateTokens(text) };
  }
}

export class BedrockLlm implements LlmClient {
  readonly name = "bedrock";
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly opts: { region: string; modelId: string; client?: BedrockRuntimeClient }) {
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region });
  }

  get model(): string {
    return this.opts.modelId;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const output = await this.client.send(
      new ConverseCommand({
        modelId: this.opts.modelId,
        system: [{ text: request.system }],
        messages: [{ role: "user", content: [{ text: request.user }] }],
        inferenceConfig: { maxTokens: request.maxTokens, temperature: request.temperature ?? 0.2 },
      }),
    );
    const blocks = output.output?.message?.content ?? [];
    const text = blocks
      .map((block) => (block && "text" in block && typeof block.text === "string" ? block.text : ""))
      .join("");
    return {
      text,
      inputTokens: output.usage?.inputTokens ?? estimateTokens(request.user),
      outputTokens: output.usage?.outputTokens ?? estimateTokens(text),
    };
  }
}

export function createLlmClient(config: LojoConfig, secrets: { grokApiKey?: string } = {}): LlmClient {
  switch (config.llmProvider) {
    case "mock":
      return new MockLlm();
    case "grok":
      if (!secrets.grokApiKey) {
        throw new Error("Grok is selected but no API key was provided");
      }
      return new GrokLlm({ apiKey: secrets.grokApiKey, baseUrl: config.grokBaseUrl, model: config.grokModel });
    case "ollama":
      return new OllamaLlm({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        embedModel: config.ollamaEmbedModel,
      });
    case "bedrock":
      return new BedrockLlm({ region: config.bedrockRegion, modelId: config.bedrockModelId });
    default:
      return assertNever(config.llmProvider, "llm provider");
  }
}
