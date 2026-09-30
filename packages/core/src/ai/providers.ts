import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { assertNever } from "../errors.ts";
import type { LojoConfig } from "../types.ts";
import { googleEndpointFor } from "./google-endpoint.ts";
import { googleHeaders, googleModelUrl, type GoogleEndpoint } from "./google-auth.ts";
import { estimateTokens, postJsonOrThrow, trimSlash, type FetchLike } from "./http.ts";
import type { LlmClient, LlmCompletion, LlmRequest, ProviderSecrets } from "./types.ts";

export class MockLlm implements LlmClient {
  readonly name = "mock";
  readonly model = "mock";
  readonly calls: LlmRequest[] = [];

  constructor(private readonly script?: (request: LlmRequest) => LlmCompletion | Promise<LlmCompletion>) {}

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.calls.push(request);
    if (this.script) return this.script(request);
    if (request.system.startsWith("Rewrite the email")) {
      return {
        text: "Hi,\n\nA shorter note. I will follow up.\n\nJon",
        inputTokens: estimateTokens(request.system + request.user),
        outputTokens: 12,
      };
    }
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
}

/**
 * Any `/chat/completions` endpoint: OpenAI, xAI Grok, OpenRouter, Groq, Together,
 * or a local llama.cpp / vLLM / LM Studio / Ollama `/v1` server. The key is
 * optional because local servers do not need one.
 */
export class OpenAiCompatibleLlm implements LlmClient {
  constructor(
    private readonly opts: { name?: string; apiKey?: string; baseUrl: string; model: string; fetchImpl?: FetchLike; timeoutMs?: number },
  ) {}

  get name(): string {
    return this.opts.name ?? "openai";
  }

  get model(): string {
    return this.opts.model;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const payload = await postJsonOrThrow<{
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>(
      this.name,
      `${trimSlash(this.opts.baseUrl)}/chat/completions`,
      {
        model: this.opts.model,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      },
      {
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
      },
    );
    const text = payload.choices?.[0]?.message?.content ?? "";
    return {
      text,
      inputTokens: payload.usage?.prompt_tokens ?? estimateTokens(request.system + request.user),
      outputTokens: payload.usage?.completion_tokens ?? estimateTokens(text),
    };
  }
}

export class GrokLlm extends OpenAiCompatibleLlm {
  constructor(opts: { apiKey: string; baseUrl: string; model: string; fetchImpl?: FetchLike }) {
    super({ ...opts, name: "grok" });
  }
}

export class OllamaLlm implements LlmClient {
  readonly name = "ollama";

  constructor(private readonly opts: { baseUrl: string; model: string; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  get model(): string {
    return this.opts.model;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const payload = await postJsonOrThrow<{ message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }>(
      "Ollama",
      `${trimSlash(this.opts.baseUrl)}/api/chat`,
      {
        model: this.opts.model,
        stream: false,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        options: { temperature: request.temperature ?? 0.2, num_predict: request.maxTokens },
      },
      {
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
      },
    );
    const text = payload.message?.content ?? "";
    return {
      text,
      inputTokens: payload.prompt_eval_count ?? estimateTokens(request.user),
      outputTokens: payload.eval_count ?? estimateTokens(text),
    };
  }
}

/** Converse works across Bedrock chat models: Amazon Nova, Anthropic Claude, Meta Llama, Mistral. */
export class BedrockLlm implements LlmClient {
  readonly name = "bedrock";
  private readonly client: Pick<BedrockRuntimeClient, "send">;

  constructor(private readonly opts: { region: string; modelId: string; client?: Pick<BedrockRuntimeClient, "send"> }) {
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

/** Gemini models through the Gemini API (AI Studio key) or Vertex AI. */
export class GeminiLlm implements LlmClient {
  constructor(
    private readonly opts: { name?: string; model: string; endpoint: GoogleEndpoint; fetchImpl?: FetchLike; timeoutMs?: number },
  ) {}

  get name(): string {
    return this.opts.name ?? (this.opts.endpoint.kind === "studio" ? "gemini" : "vertex");
  }

  get model(): string {
    return this.opts.model;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const payload = await postJsonOrThrow<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>(
      this.name,
      googleModelUrl(this.opts.endpoint, this.opts.model, "generateContent"),
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        generationConfig: { temperature: request.temperature ?? 0.2, maxOutputTokens: request.maxTokens },
      },
      {
        headers: await googleHeaders(this.opts.endpoint),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
      },
    );
    const text = (payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    return {
      text,
      inputTokens: payload.usageMetadata?.promptTokenCount ?? estimateTokens(request.system + request.user),
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? estimateTokens(text),
    };
  }
}

export function createLlmClient(config: LojoConfig, secrets: ProviderSecrets = {}, fetchImpl?: FetchLike): LlmClient {
  const withFetch = fetchImpl ? { fetchImpl } : {};
  switch (config.llmProvider) {
    case "mock":
      return new MockLlm();
    case "grok":
      if (!secrets.grokApiKey) throw new Error("Grok is selected but no API key was provided");
      return new GrokLlm({ apiKey: secrets.grokApiKey, baseUrl: config.grokBaseUrl, model: config.grokModel, ...withFetch });
    case "openai":
      return new OpenAiCompatibleLlm({
        baseUrl: config.openaiBaseUrl,
        model: config.openaiModel,
        ...(secrets.openaiApiKey ? { apiKey: secrets.openaiApiKey } : {}),
        ...withFetch,
      });
    case "ollama":
      return new OllamaLlm({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel, ...withFetch });
    case "bedrock":
      return new BedrockLlm({ region: config.bedrockRegion, modelId: config.bedrockModelId });
    case "gemini":
    case "vertex":
      return new GeminiLlm({ model: config.geminiModel, endpoint: googleEndpointFor(config.llmProvider, config, secrets, fetchImpl), ...withFetch });
    default:
      return assertNever(config.llmProvider, "llm provider");
  }
}
