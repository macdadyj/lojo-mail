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

export interface Message {
  id: string;
  threadId: string;
  folder: string;
  from: Address;
  to: Address[];
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  labels: string[];
  bulk: boolean;
  pgpEncrypted: boolean;
  ai: AiPublic | null;
  locked: boolean;
  text?: string;
  summary?: string;
  actionItems?: ActionItem[];
  draftReply?: string;
  phishingReasons?: string[];
  attachments: Array<{ id: string; filename: string; contentType: string; size: number }>;
}

export interface DraftRow {
  draft: {
    id: string;
    subject: string;
    status: string;
    to: Address[];
    aiGenerated: boolean;
    updatedAt: string;
  };
  text: string | null;
}

export interface Settings {
  mailbox: string;
  domain: string;
  llmProvider: string;
  dailyTokenBudget: number;
  budgetUsed: number;
  unlocked: boolean;
  dev: boolean;
}

export function person(address: Address): string {
  return address.name || address.email;
}

export function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
