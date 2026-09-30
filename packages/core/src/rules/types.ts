import type { Category, Priority } from "../types.ts";

/** Where a rule may file mail. Sent, drafts and trash are not destinations (trash has its own action). */
export type RuleFolder = "inbox" | "archive" | "spam";

export const RULE_FOLDERS = ["inbox", "archive", "spam"] as const satisfies readonly RuleFolder[];

/**
 * Every present field must match; inside a list, any entry matches. Sender
 * patterns are an exact address or `@domain` (that domain only, no subdomains).
 * `categories`, `priorities` and `aiLabels` come from the model, so an email
 * can steer them: they may narrow an auto-send allowlist but never replace it.
 */
export interface RuleMatch {
  from?: string[];
  to?: string[];
  subjectContains?: string[];
  listId?: string[];
  categories?: Category[];
  priorities?: Priority[];
  aiLabels?: string[];
  bulk?: boolean;
  hasAttachment?: boolean;
}

export type ReplyMode = "draft" | "autoSend";

export interface ReplyAction {
  /** `draft` (default) parks the reply in the approval queue. `autoSend` needs every guard in autosend.ts. */
  mode: ReplyMode;
  /** Jon's fixed text. `{{first_name}}` is the only placeholder. Exactly one of template and ai. */
  template?: string;
  /** Jon's instruction to the model. The model sees only this message, never the mailbox. */
  ai?: { instruction: string };
  maxChars: number;
  /** Required for autoSend: exact addresses or `@domain`. */
  allowSenders: string[];
  /** Optional extra narrowing for autoSend. */
  allowCategories: Category[];
  perSenderPerDay: number;
  perDay: number;
}

export type RuleAction =
  | { type: "label"; labels: string[] }
  | { type: "move"; folder: RuleFolder }
  | { type: "markRead" }
  | { type: "trash" }
  | { type: "reply"; reply: ReplyAction };

export type RuleAuthor = "human" | "token";

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  actions: RuleAction[];
  /** Stop evaluating later rules once this one matches. */
  stop: boolean;
  /** Stamped by the API from the session, never taken from the request body. */
  createdBy: RuleAuthor;
  updatedAt: string;
}

export interface RulesDocument {
  version: 1;
  /** Every rule is off while paused. A token may pause; only Jon can resume. */
  paused: boolean;
  /** Auto-send is off and replies fall back to drafts. A token may engage it; only Jon can release it. */
  killSwitch: boolean;
  /** Mail a rule trashes stays restorable at least this long. */
  trashRetentionDays: number;
  /** Across all rules, per UTC day. */
  maxAutoSendPerDay: number;
  rules: Rule[];
  updatedAt: string;
  updatedBy: RuleAuthor;
}

/** What one rule would do to one message. */
export interface RuleHit {
  ruleId: string;
  name: string;
  actions: RuleAction["type"][];
}

/** The folder, labels and read state a message gets from the rules, before it is stored. */
export interface RuleOutcome {
  hits: RuleHit[];
  labels: string[];
  folder: RuleFolder | "trash" | null;
  trashRuleId: string | null;
  markRead: boolean;
  reply: { rule: Rule; action: ReplyAction } | null;
}
