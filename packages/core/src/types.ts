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

/**
 * Who may soft-delete: Jon's session, the Thunderbird bridge token, or an agent
 * or bot token Jon granted the `trash` scope (`agent:<label>`, `bot:<name>`, each capped per day).
 */
export type TrashActor = "human" | "bridge" | `agent:${string}` | `bot:${string}`;

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

export interface DraftAttachment extends AttachmentMeta {
  /** Hex SHA-256 of the bytes. The approval names files by it. */
  sha256: string;
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
  /** Sent mail only: the Bcc recipients Jon's client sent to. Never in the delivered message. */
  bcc?: Address[];
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
  /** The List-Id header, for rules. */
  listId?: string;
  /** Header-derived reasons never to auto-reply (rules/autosend.ts). Codes only. */
  replyBlockers?: string[];
  pgpEncrypted: boolean;
  verdicts?: Verdicts;
  bodyKey: string;
  aiContextKey?: string;
  /** `{text, html}` sealed to the bot envelope key `botKeyId` (bots/copies.ts). Only when Jon registered a bot key. */
  botBodyKey?: string;
  botKeyId?: string;
  ai: AiPublic | null;
  /** Packed int8 embedding (see ai/vectors.ts). Derived from plaintext; never returned by the API. */
  vec?: string;
  /** Which embedder produced `vec`. The sparse `vectors` index is keyed on it. */
  vecModel?: string;
  /** Set when the message moved to trash. Only the trash purge (trash/purge.ts) ever hard deletes. */
  trashedAt?: string;
  /** `rule:<id>`, `human`, `bridge`, or `agent:<label>`. */
  trashedBy?: string;
  /** Earliest time the purge may delete it. Until then it is always restorable. */
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
  /** Files to send with the draft, in order. The bytes are sealed in the blob store (`draftAttachmentKey`). */
  attachments?: DraftAttachment[];
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
  /**
   * Set when Jon sent this draft from his own mail client through the bridge.
   * `unchanged` records whether what went out still matched the draft text.
   */
  clientSent?: { at: string; unchanged: boolean };
  /** The Message-ID Jon's mail client gave the draft it saved, so it can find the draft again. */
  clientMessageId?: string;
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
  /** Who caused it through the API: `human`, `bridge`, `api`, `agent:<label>` or `bot:<name>`. Absent for the pipeline. */
  actor?: string;
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
  bcc?: Address[];
  botBodyKey?: string;
  botKeyId?: string;
}

export interface LojoConfig {
  domain: string;
  localPart: string;
  region: string;
  mailbox: string;
  /** Addresses Jon's client may send as: the mailbox first, then LOJO_SEND_FROM extras (each a verified SES identity). */
  sendFrom: string[];
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
  bcc?: Address[];
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
