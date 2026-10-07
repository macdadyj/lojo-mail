import type { Rule } from "../rules/types.ts";
import type { Folder } from "../types.ts";

/** What SI may do to a message. There is no hard-delete action. */
export type SiAction =
  | { type: "label"; labels: string[] }
  | { type: "spam" }
  | { type: "trash" }
  | { type: "blockSender" }
  | { type: "blockDomain" };

export const SI_ACTION_TYPES = ["label", "spam", "trash", "blockSender", "blockDomain"] as const;

/** Labels SI is asked to prefer. Any other label that passes the rules grammar is allowed too. */
export const SI_LABELS = ["receipts", "newsletters", "church", "family", "work"] as const;

export const SI_TONES = ["friendly", "brief", "formal", "warm", "direct"] as const;
export type SiTone = (typeof SI_TONES)[number];

export interface SiProposal {
  messageId: string;
  from: string;
  domain: string;
  subject: string;
  reason: string;
  actions: SiAction[];
  /** When true, label / junk / trash also become a mail rule for new mail. Blocks always save a rule. */
  saveRule: boolean;
}

export interface SiFilterResult {
  killSwitch: boolean;
  proposals: SiProposal[];
}

export interface SiApplyItem {
  messageId: string;
  actions: SiAction[];
  saveRule: boolean;
}

export interface SiApplyResult {
  changeId: string;
  applied: number;
  rules: number;
  /** Apply records an undo entry. Nothing is hard-deleted. */
  undo: true;
}

export interface SiBlock {
  ruleId: string;
  kind: "sender" | "domain";
  value: string;
  name: string;
}

export interface SiMessageSnapshot {
  folder: Folder;
  labels: string[];
  unread: boolean;
}

export interface SiMessageChange {
  messageId: string;
  before: SiMessageSnapshot;
  afterFolder: Folder;
  afterLabels: string[];
}

/** `before` is the rule this change replaced (null if it created one). `after` is what it wrote (null if it removed one). */
export interface SiRuleChange {
  id: string;
  before: Rule | null;
  after: Rule | null;
}

export interface SiChange {
  id: string;
  at: string;
  messages: SiMessageChange[];
  rules: SiRuleChange[];
}

export interface SiLedger {
  version: 1;
  changes: SiChange[];
}

export interface SiReplyInput {
  messageId: string;
  tone?: string;
  instruction?: string;
  /** Body the phone decrypted. The API cannot open envelopes. */
  sourceText?: string;
  /** Earlier messages in the thread, already decrypted on the phone. */
  threadText?: string;
}
