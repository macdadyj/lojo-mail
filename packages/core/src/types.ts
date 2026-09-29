export type Folder = "inbox" | "sent" | "drafts" | "spam" | "trash" | "archive";

export const FOLDERS = ["inbox", "sent", "drafts", "spam", "trash", "archive"] as const satisfies readonly Folder[];

export type Category = "personal" | "transactional" | "newsletter" | "notification" | "phishing" | "other";

export type Priority = "now" | "today" | "later" | "noise";

export type LlmProviderName = "grok" | "bedrock" | "ollama" | "mock";

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
  v: 1;
  alg: "P-256-ECDH+HKDF-SHA256+AES-256-GCM";
  epk: EcPublicJwk;
  iv: string;
  ct: string;
}

export interface ActionItem {
  text: string;
  deadline: string | null;
}

export interface SealedBody {
  text: string;
  html: string;
  attachments: Array<{
    id: string;
    filename: string;
    contentType: string;
    bytesB64: string;
  }>;
  ai: {
    summary: string;
    threadSummary: string;
    actionItems: ActionItem[];
    draftReply: string;
    phishingReasons: string[];
    unsubscribeUrl?: string;
    unsubscribeMailto?: string;
  } | null;
}

export interface AiPublic {
  category: Category;
  priority: Priority;
  phishingScore: number;
  labels: string[];
  unsubscribeDetected: boolean;
  skipped: boolean;
  skipReason?: "bulk" | "budget" | "pgp" | "error" | "disabled";
}

export interface StoredMessage {
  id: string;
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
  attachments: AttachmentMeta[];
  inReplyTo?: string;
  references: string[];
  bulk: boolean;
  pgpEncrypted: boolean;
  envelope: EnvelopeBlob;
  ai: AiPublic | null;
  embedding: number[] | null;
  rawKey?: string;
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

export type DraftStatus = "suggested" | "edited" | "sent" | "discarded";

export interface Draft {
  id: string;
  threadId?: string;
  inReplyTo?: string;
  to: Address[];
  cc: Address[];
  subject: string;
  status: DraftStatus;
  aiGenerated: boolean;
  envelope: EnvelopeBlob;
  createdAt: string;
  updatedAt: string;
  sentMessageId?: string;
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
  embedding?: number[] | null;
  envelope?: EnvelopeBlob;
}

export interface LojoConfig {
  domain: string;
  localPart: string;
  region: string;
  mailbox: string;
  llmProvider: LlmProviderName;
  dailyTokenBudget: number;
  maxBodyChars: number;
  skipBulk: boolean;
  snippetInClear: boolean;
  grokBaseUrl: string;
  grokModel: string;
  bedrockModelId: string;
  bedrockRegion: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
}

export interface MessageView {
  id: string;
  threadId: string;
  folder: Folder;
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
  ai: AiPublic | null;
  locked: boolean;
  text?: string;
  html?: string;
  summary?: string;
  threadSummary?: string;
  actionItems?: ActionItem[];
  draftReply?: string;
  phishingReasons?: string[];
}
