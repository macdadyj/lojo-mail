import { postJsonOrThrow, trimSlash, type FetchLike } from "@lojo/core";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatTurn {
  content: string;
  toolCalls: ToolCall[];
}

/** A chat model that can call tools. Implemented for Ollama and for any OpenAI-compatible server. */
export interface ChatBackend {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatTurn>;
}

function asFunctions(tools: ChatTool[]) {
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

/** Small models sometimes send arguments as a JSON string, or as nothing. */
export function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/** Ollama `/api/chat` with `tools` (llama3.1+, llama3.2, qwen2.5, mistral-nemo, and others). */
export class OllamaChat implements ChatBackend {
  readonly name = "ollama";

  constructor(private readonly opts: { baseUrl: string; model: string; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  get model(): string {
    return this.opts.model;
  }

  async chat(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatTurn> {
    const payload = await postJsonOrThrow<{
      message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> };
    }>(
      "Ollama",
      `${trimSlash(this.opts.baseUrl)}/api/chat`,
      {
        model: this.opts.model,
        stream: false,
        options: { temperature: 0.1 },
        tools: asFunctions(tools),
        messages: messages.map((message) => {
          switch (message.role) {
            case "system":
            case "user":
              return { role: message.role, content: message.content };
            case "assistant":
              return {
                role: "assistant",
                content: message.content,
                ...(message.toolCalls?.length
                  ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) }
                  : {}),
              };
            case "tool":
              return { role: "tool", content: message.content, tool_name: message.name };
            default: {
              const unexpected: never = message;
              throw new Error(`Unknown message ${String(unexpected)}`);
            }
          }
        }),
      },
      { ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}), timeoutMs: this.opts.timeoutMs ?? 120_000 },
    );
    const calls = payload.message?.tool_calls ?? [];
    return {
      content: payload.message?.content ?? "",
      toolCalls: calls
        .filter((call) => typeof call.function?.name === "string")
        .map((call, index) => ({ id: call.id ?? `call_${index}`, name: call.function?.name ?? "", arguments: parseArguments(call.function?.arguments) })),
    };
  }
}

/** `/chat/completions` with `tools`: llama.cpp server, vLLM, LM Studio, Ollama's `/v1`, or a hosted API. */
export class OpenAiChat implements ChatBackend {
  readonly name = "openai";

  constructor(private readonly opts: { baseUrl: string; model: string; apiKey?: string; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  get model(): string {
    return this.opts.model;
  }

  async chat(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatTurn> {
    const payload = await postJsonOrThrow<{
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    }>(
      "openai",
      `${trimSlash(this.opts.baseUrl)}/chat/completions`,
      {
        model: this.opts.model,
        temperature: 0.1,
        tools: asFunctions(tools),
        messages: messages.map((message) => {
          switch (message.role) {
            case "system":
            case "user":
              return { role: message.role, content: message.content };
            case "assistant":
              return {
                role: "assistant",
                content: message.content,
                ...(message.toolCalls?.length
                  ? {
                      tool_calls: message.toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                      })),
                    }
                  : {}),
              };
            case "tool":
              return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
            default: {
              const unexpected: never = message;
              throw new Error(`Unknown message ${String(unexpected)}`);
            }
          }
        }),
      },
      {
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        timeoutMs: this.opts.timeoutMs ?? 120_000,
      },
    );
    const message = payload.choices?.[0]?.message;
    return {
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? [])
        .filter((call) => typeof call.function?.name === "string")
        .map((call, index) => ({ id: call.id ?? `call_${index}`, name: call.function?.name ?? "", arguments: parseArguments(call.function?.arguments) })),
    };
  }
}
