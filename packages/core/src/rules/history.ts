import { MailError } from "../errors.ts";
import type { Rule, RulesDocument } from "./types.ts";
import { ruleFingerprint } from "./validate.ts";

/** How far back `undo_last_change` can reach. Older edits stay in the audit log. */
export const MAX_RULE_REVISIONS = 20;
export const RULE_WHY_MAX = 200;

export interface RuleRevision {
  at: string;
  actor: string;
  why: string;
  op: "upsert" | "delete";
  ruleId: string;
  /** The rule before this edit. Null when the edit created it. */
  before: Rule | null;
  /** Fingerprint of the rule after an upsert, so undo refuses if it has since changed. */
  afterHash: string;
  /** Where the rule sat before the edit. A create uses the list length. */
  index: number;
}

export interface RuleHistory {
  version: 1;
  revisions: RuleRevision[];
}

export function emptyRuleHistory(): RuleHistory {
  return { version: 1, revisions: [] };
}

/** A short reason, required on every assistant rule edit. Collapses whitespace. */
export function ruleWhy(value: unknown): string {
  if (typeof value !== "string") throw new MailError("why is required: a short reason for this rule change", "invalid");
  const why = value.trim().replace(/\s+/g, " ");
  if (why.length < 1 || why.length > RULE_WHY_MAX) throw new MailError(`why must be 1-${RULE_WHY_MAX} characters`, "invalid");
  return why;
}

export function pushRevision(history: RuleHistory, revision: RuleRevision): RuleHistory {
  return { version: 1, revisions: [...history.revisions, revision].slice(-MAX_RULE_REVISIONS) };
}

export interface UndoResult {
  doc: RulesDocument;
  history: RuleHistory;
  undone: RuleRevision;
}

/**
 * Pops the latest assistant edit and reverses it. Refuses when the rule is no
 * longer what that edit wrote, so undo cannot clobber a later change.
 */
export function undoRevision(doc: RulesDocument, history: RuleHistory, at: Date): UndoResult {
  const revision = history.revisions.at(-1);
  if (!revision) throw new MailError("No rule change to undo", "not_found");
  const current = doc.rules.find((rule) => rule.id === revision.ruleId);
  const rules = reversed(doc, revision, current);
  return {
    doc: { ...doc, rules, updatedAt: at.toISOString(), updatedBy: "bot" },
    history: { version: 1, revisions: history.revisions.slice(0, -1) },
    undone: revision,
  };
}

function reversed(doc: RulesDocument, revision: RuleRevision, current: Rule | undefined): Rule[] {
  switch (revision.op) {
    case "upsert":
      if (!current || ruleFingerprint(current) !== revision.afterHash) {
        throw new MailError(`Rule ${revision.ruleId} changed since that edit. It was not undone.`, "conflict");
      }
      return revision.before ? doc.rules.map((rule) => (rule.id === revision.ruleId ? revision.before ?? rule : rule)) : doc.rules.filter((rule) => rule.id !== revision.ruleId);
    case "delete": {
      if (current) throw new MailError(`Rule ${revision.ruleId} is already there. It was not undone.`, "conflict");
      if (!revision.before) throw new MailError(`Rule ${revision.ruleId} has nothing to restore`, "conflict");
      const index = Math.max(0, Math.min(revision.index, doc.rules.length));
      return [...doc.rules.slice(0, index), revision.before, ...doc.rules.slice(index)];
    }
    default: {
      const unexpected: never = revision.op;
      throw new Error(`Unknown rule revision ${String(unexpected)}`);
    }
  }
}
