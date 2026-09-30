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
}

/** Retrieval models embed stored mail and search queries differently (task types, nomic prefixes). */
export type EmbedPurpose = "document" | "query";

export interface Embedder {
  readonly name: string;
  readonly model: string;
  /** Stored vectors are truncated to this many dimensions. 0 keeps the model's native size. */
  readonly dimensions: number;
  embed(text: string, purpose: EmbedPurpose): Promise<LlmEmbedding>;
}

/** API keys and credentials, read from SSM or the environment. Only the selected providers' are loaded. */
export interface ProviderSecrets {
  grokApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  /** Service account key JSON for Vertex AI. Without it Vertex uses express mode with geminiApiKey. */
  vertexServiceAccount?: string;
}
