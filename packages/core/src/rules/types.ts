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

/**
 * `draft` (default) parks the reply in the approval queue. `shadow` runs every
 * auto-send guard and audits what would have gone out, sending and storing
 * nothing. `autoSend` needs every guard in autosend.ts, and Jon must have run
 * the rule in `shadow` first.
 */
export type ReplyMode = "draft" | "shadow" | "autoSend";

export interface ReplyAction {
  mode: ReplyMode;
  /** Jon's fixed text. `{{first_name}}` is the only placeholder. Exactly one of template and ai. */
  template?: string;
  /** Jon's instruction to the model. The model sees only this message, never the mailbox. */
  ai?: { instruction: string };
  /** Jon's per-rule opt-in to auto-sending model-written text. Without it an `ai` reply never auto-sends. */
  allowAiText: boolean;
  maxChars: number;
  /** Exact addresses or `@domain`. Auto-send needs these, or a fixed template with allowCategories. */
  allowSenders: string[];
  /** Narrows the allowlist; with a fixed template it may stand in for allowSenders. */
  allowCategories: Category[];
  perSenderPerDay: number;
  perDay: number;
}

/** `shadow` audits what it would do; `auto` sends the request. Same shadow-first rule as auto-send replies. */
export type UnsubscribeMode = "shadow" | "auto";

/**
 * Answers a List-Unsubscribe header (RFC 2369 mailto, RFC 8058 one-click),
 * the one automation that may act on bulk mail. See rules/unsubscribe.ts.
 */
export interface UnsubscribeAction {
  mode: UnsubscribeMode;
  /** Optional: exact addresses or `@domain`. Empty means every message the rule matches. */
  allowSenders: string[];
  perDay: number;
}

export type RuleAction =
  | { type: "label"; labels: string[] }
  | { type: "move"; folder: RuleFolder }
  | { type: "markRead" }
  | { type: "trash" }
  | { type: "reply"; reply: ReplyAction }
  | { type: "unsubscribe"; unsubscribe: UnsubscribeAction };

/** `bot`: written through a bot credential's `rules` scope (bot-rules.ts). Never auto-sends, never trashes. */
export type RuleAuthor = "human" | "token" | "bot";

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
  /**
   * Nothing leaves the mailbox: no Thunderbird send, no approved send, no
   * auto-send. A token may engage it; only Jon can release it.
   */
  sendKillSwitch: boolean;
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
  unsubscribe: { rule: Rule; action: UnsubscribeAction } | null;
}
