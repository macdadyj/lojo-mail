export type Folder = "inbox" | "sent" | "drafts" | "spam" | "trash" | "archive";

export const FOLDERS = ["inbox", "sent", "drafts", "spam", "trash", "archive"] as const satisfies readonly Folder[];

export type Category = "personal" | "transactional" | "newsletter" | "notification" | "phishing" | "other";

export type Priority = "now" | "today" | "later" | "noise";

export type LlmProviderName = "grok" | "bedrock" | "ollama" | "openai" | "gemini" | "vertex" | "mock";

export type EmbedProviderName = "ollama" | "bedrock" | "openai" | "gemini" | "vertex" | "mock" | "none";

/** Where a message came from. Decides its folder; headers never do. */
export type MessageOrigin = "inbound" | "sent" | "import";

/** Who is acting on the mailbox. Agents are default-deny for destructive actions. */
export type Actor = "human" | "agent";

export interface Address {
  name?: string;
  email: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface StoredAttachment extends AttachmentMeta {
  blobKey: string;
}

export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  ext?: boolean;
  key_ops?: string[];
}

export interface EcPrivateJwk extends EcPublicJwk {
  d: string;
}

export interface EnvelopeBlob {
  v: 2;
  alg: "P-256-ECDH+HKDF-SHA256+AES-256-GCM";
  epk: EcPublicJwk;
  iv: string;
  ct: string;
}

export type EncryptionContext = Record<string, string>;

/** AES-256-GCM under a data key that a KeyWrapper (KMS in AWS) wraps for one encryption context. */
export interface ServerSealedBlob {
  v: 1;
  alg: "AES-256-GCM+wrapped-data-key";
  ctx: EncryptionContext;
  wrappedKey: string;
  iv: string;
  ct: string;
}

export interface ActionItem {
  text: string;
  deadline: string | null;
}

export interface SensitiveAi {
  summary: string;
  threadSummary: string;
  actionItems: ActionItem[];
  draftReply: string;
  phishingReasons: string[];
  unsubscribeUrl?: string;
  unsubscribeMailto?: string;
}

/** Sealed to Jon's envelope key at `objects/{id}.bin`. Attachments are sealed separately. */
export interface SealedBody {
  text: string;
  html: string;
  ai: SensitiveAi | null;
}

export type SkipReason = "bulk" | "budget" | "pgp" | "error" | "disabled" | "quarantined" | "dmarc-report" | "sent";

export interface AiPublic {
  category: Category;
  priority: Priority;
  phishingScore: number;
  labels: string[];
  unsubscribeDetected: boolean;
  skipped: boolean;
  skipReason?: SkipReason;
}

/** SES receipt verdicts and the topmost amazonses.com Authentication-Results. */
export interface Verdicts {
  spam?: string;
  virus?: string;
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

export interface StoredMessage {
  id: string;
  deliveryId: string;
  origin: MessageOrigin;
  rfcMessageId: string;
  threadId: string;
  folder: Folder;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo?: Address;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  labels: string[];
  attachments: StoredAttachment[];
  inReplyTo?: string;
  references: string[];
  bulk: boolean;
  pgpEncrypted: boolean;
  verdicts?: Verdicts;
  bodyKey: string;
  aiContextKey?: string;
  ai: AiPublic | null;
  /** Packed int8 embedding (see ai/vectors.ts). Derived from plaintext; never returned by the API. */
  vec?: string;
  /** Which embedder produced `vec`. The sparse `vectors` index is keyed on it. */
  vecModel?: string;
  /** Set when a rule moved the message to trash. Rules never hard delete. */
  trashedAt?: string;
  /** `rule:<id>` or `human`. */
  trashedBy?: string;
  /** Earliest time anything may purge it. Until then it is always restorable. */
  keepUntil?: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  subject: string;
  participants: string[];
  lastDate: string;
  unreadCount: number;
  messageIds: string[];
  folder: Folder;
  priority?: Priority;
}

export type DraftStatus = "suggested" | "edited" | "pending_approval" | "sending" | "sent" | "discarded";

/**
 * Who wrote a draft. `client` is Jon's own mail client through the local bridge
 * (a token with the `compose` scope); `rule` is one of Jon's mail rules.
 */
export type DraftOrigin = "human" | "agent" | "ai" | "client" | "rule";

export type PgpMode = "auto" | "off";

export interface Draft {
  id: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
  to: Address[];
  cc: Address[];
  subject: string;
  status: DraftStatus;
  origin: DraftOrigin;
  /** Who wrote the current content, when it was changed after creation. */
  lastEditedBy?: DraftOrigin;
  aiGenerated: boolean;
  pgp: PgpMode;
  /** Draft text, sealed with a KMS data key under `{ purpose: "draft", draftId }`. */
  sealed: ServerSealedBlob;
  createdAt: string;
  updatedAt: string;
  sentMessageId?: string;
  approvalTokenHash?: string;
  approvalContentHash?: string;
  approvalExpiresAt?: string;
  approvalUsedAt?: string;
  /** The rule that wrote or auto-sent this draft. */
  ruleId?: string;
  /** Set when a rule sent this draft without an approval token (see rules/autosend.ts). */
  autoSentAt?: string;
}

export interface AuditEvent {
  id: string;
  day: string;
  at: string;
  action: string;
  messageId?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  outcome: string;
  promptSha256?: string;
  detail?: string;
}

export interface Contact {
  email: string;
  name?: string;
  pgpPublicKey?: string;
}

export interface ListQuery {
  folder?: Folder;
  label?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface MessagePatch {
  folder?: Folder;
  unread?: boolean;
  labels?: string[];
  ai?: AiPublic | null;
  vec?: string;
  vecModel?: string;
  threadId?: string;
  trashedAt?: string;
  trashedBy?: string;
  keepUntil?: string;
}

export interface LojoConfig {
  domain: string;
  localPart: string;
  region: string;
  mailbox: string;
  dmarcMailbox: string;
  llmProvider: LlmProviderName;
  dailyTokenBudget: number;
  maxBodyChars: number;
  skipBulk: boolean;
  snippetInClear: boolean;
  /** Days to keep the KMS-sealed AI-context copy of inbound text. 0 disables it. */
  aiContextDays: number;
  grokBaseUrl: string;
  grokModel: string;
  bedrockModelId: string;
  bedrockRegion: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiEmbedModel: string;
  geminiModel: string;
  geminiEmbedModel: string;
  vertexProject: string;
  vertexLocation: string;
  bedrockEmbedModelId: string;
  embedProvider: EmbedProviderName;
  /** Stored vector size. 0 keeps each model's native size. */
  embedDimensions: number;
}

export interface MessageView {
  id: string;
  threadId: string;
  rfcMessageId: string;
  inReplyTo?: string;
  references: string[];
  replyTo?: Address;
  folder: Folder;
  origin: MessageOrigin;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  labels: string[];
  attachments: AttachmentMeta[];
  bulk: boolean;
  pgpEncrypted: boolean;
  verdicts?: Verdicts;
  ai: AiPublic | null;
  trashedAt?: string;
  trashedBy?: string;
  keepUntil?: string;
  /** True when the server cannot open the body. The browser fetches `/v1/messages/:id/body` and opens it locally. */
  locked: boolean;
  text?: string;
  html?: string;
  summary?: string;
  threadSummary?: string;
  actionItems?: ActionItem[];
  draftReply?: string;
  phishingReasons?: string[];
  /** Server-readable AI-context text. Only returned to principals with the `body` scope. */
  contextText?: string;
}

export interface DraftView {
  draft: Omit<Draft, "sealed" | "approvalTokenHash">;
  text: string | null;
}
