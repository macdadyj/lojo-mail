import { assertNever } from "../errors.ts";
import type { StoredMessage } from "../types.ts";
import type { Rule, RuleHit, RuleMatch, RuleOutcome, RulesDocument } from "./types.ts";

/** What matching may look at: metadata plus the List-Id header. Never body text. */
export type MatchInput = Pick<StoredMessage, "from" | "to" | "cc" | "subject" | "ai" | "bulk" | "attachments" | "labels"> & {
  listId?: string;
};

export function senderMatches(email: string, patterns: readonly string[]): boolean {
  const lower = email.trim().toLowerCase();
  const domain = lower.split("@")[1] ?? "";
  return patterns.some((pattern) => (pattern.startsWith("@") ? domain === pattern.slice(1) : lower === pattern));
}

function anyIncludes(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

export function ruleMatches(match: RuleMatch, input: MatchInput): boolean {
  if (match.from?.length && !senderMatches(input.from.email, match.from)) return false;
  if (match.to?.length && ![...input.to, ...input.cc].some((address) => senderMatches(address.email, match.to ?? []))) return false;
  if (match.subjectContains?.length && !anyIncludes(input.subject, match.subjectContains)) return false;
  if (match.listId?.length && !(input.listId && anyIncludes(input.listId, match.listId))) return false;
  if (match.categories?.length && !(input.ai && match.categories.includes(input.ai.category))) return false;
  if (match.priorities?.length && !(input.ai && match.priorities.includes(input.ai.priority))) return false;
  if (match.aiLabels?.length && !(input.ai && input.ai.labels.some((item) => match.aiLabels?.includes(item.toLowerCase())))) return false;
  if (match.bulk !== undefined && input.bulk !== match.bulk) return false;
  if (match.hasAttachment !== undefined && input.attachments.length > 0 !== match.hasAttachment) return false;
  return true;
}

/**
 * Folds every enabled matching rule into one outcome, in document order. Labels
 * accumulate; the last move wins; trash beats any move; the first reply wins.
 */
export function evaluateRules(doc: RulesDocument, input: MatchInput): RuleOutcome {
  const outcome: RuleOutcome = { hits: [], labels: [], folder: null, trashRuleId: null, markRead: false, reply: null };
  if (doc.paused) return outcome;
  const labels = new Set<string>();
  for (const rule of doc.rules) {
    if (!rule.enabled || !ruleMatches(rule.match, input)) continue;
    outcome.hits.push(hitOf(rule));
    for (const action of rule.actions) {
      switch (action.type) {
        case "label":
          for (const item of action.labels) labels.add(item);
          break;
        case "move":
          if (outcome.folder !== "trash") outcome.folder = action.folder;
          break;
        case "markRead":
          outcome.markRead = true;
          break;
        case "trash":
          outcome.folder = "trash";
          outcome.trashRuleId ??= rule.id;
          break;
        case "reply":
          outcome.reply ??= { rule, action: action.reply };
          break;
        default:
          assertNever(action, "rule action");
      }
    }
    if (rule.stop) break;
  }
  if (outcome.folder === "trash") outcome.reply = null;
  outcome.labels = [...labels];
  return outcome;
}

function hitOf(rule: Rule): RuleHit {
  return { ruleId: rule.id, name: rule.name, actions: rule.actions.map((action) => action.type) };
}
