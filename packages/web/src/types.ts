import type { EnvelopeBlob } from "@lojo/core/crypto";

export interface Address {
  name?: string;
  email: string;
}

export interface ActionItem {
  text: string;
  deadline: string | null;
}

export interface AiPublic {
  category: string;
  priority: "now" | "today" | "later" | "noise";
  phishingScore: number;
  labels: string[];
  unsubscribeDetected: boolean;
  skipped: boolean;
  skipReason?: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface Verdicts {
  spam?: string;
  virus?: string;
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

export interface Message {
  id: string;
  threadId: string;
  folder: string;
  origin: "inbound" | "sent" | "import";
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  labels: string[];
  bulk: boolean;
  pgpEncrypted: boolean;
  verdicts?: Verdicts;
  ai: AiPublic | null;
  locked: boolean;
  text?: string;
  summary?: string;
  threadSummary?: string;
  actionItems?: ActionItem[];
  draftReply?: string;
  phishingReasons?: string[];
  attachments: AttachmentMeta[];
  trashedAt?: string;
  trashedBy?: string;
  keepUntil?: string;
}

export interface SealedBody {
  text: string;
  html: string;
  ai: {
    summary: string;
    threadSummary: string;
    actionItems: ActionItem[];
    draftReply: string;
    phishingReasons: string[];
  } | null;
}

export interface BodyResponse {
  id: string;
  envelope: EnvelopeBlob;
}

export type AttachmentResponse = { meta: AttachmentMeta; url: string } | { meta: AttachmentMeta; envelope: EnvelopeBlob };

export type DraftStatus = "suggested" | "edited" | "pending_approval" | "sending" | "sent" | "discarded";

export interface Draft {
  id: string;
  threadId?: string;
  inReplyTo?: string;
  to: Address[];
  cc: Address[];
  bcc?: Address[];
  subject: string;
  status: DraftStatus;
  origin: "human" | "agent" | "ai" | "client" | "rule";
  lastEditedBy?: "human" | "agent" | "ai" | "client" | "rule";
  aiGenerated: boolean;
  pgp: "auto" | "off";
  createdAt: string;
  updatedAt: string;
  sentMessageId?: string;
  /** Files sent with the draft, in order. The approval names each by SHA-256. */
  attachments?: DraftAttachment[];
}

export interface DraftAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface DraftView {
  draft: Draft;
  text: string | null;
}

export interface Session {
  sessionToken: string;
  expiresAt: string;
}

export interface Settings {
  mailbox: string;
  domain: string;
  llmProvider: string;
  dailyTokenBudget: number;
  budgetUsed: number;
  unlocked: boolean;
  /** Public: which envelope key mail is sealed to. */
  envelopeKeyFingerprint?: string;
  dev: boolean;
  principal: "human" | "token";
}

export function person(address: Address): string {
  return address.name || address.email;
}

export function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function statusLabel(status: DraftStatus): string {
  switch (status) {
    case "suggested":
      return "suggested";
    case "edited":
      return "draft";
    case "pending_approval":
      return "needs approval";
    case "sending":
      return "sending";
    case "sent":
      return "sent";
    case "discarded":
      return "discarded";
    default: {
      const unexpected: never = status;
      return unexpected;
    }
  }
}

export type RuleActionSummary =
  | { type: "label" | "move" | "markRead" | "trash" }
  | { type: "reply"; reply: { mode: "draft" | "shadow" | "autoSend"; allowSenders: string[]; allowCategories: string[]; allowAiText: boolean } }
  | { type: "unsubscribe"; unsubscribe: { mode: "shadow" | "auto"; allowSenders: string[] } };

export interface RuleSummary {
  id: string;
  name: string;
  enabled: boolean;
  createdBy: "human" | "token" | "bot";
  actions: RuleActionSummary[];
}

export interface RulesView {
  rules: { paused: boolean; killSwitch: boolean; sendKillSwitch?: boolean; trashRetentionDays: number; rules: RuleSummary[]; updatedAt: string };
  fingerprints: Record<string, string>;
  autoSendEnabled: boolean;
}

export interface BotSummary {
  name: string;
  scopes: string[];
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
  sendLimits?: { perHour: number; perDay: number };
  sendGrant?: { expiresAt?: string; approvalRequired: boolean };
}

export interface BotsView {
  killSwitch: boolean;
  bots: BotSummary[];
  envelopeKey: { keyId: string } | null;
}
