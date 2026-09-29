export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}

export interface LlmCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmEmbedding {
  vector: number[];
  tokens: number;
}

export interface LlmClient {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
  embed?(text: string): Promise<LlmEmbedding>;
}
