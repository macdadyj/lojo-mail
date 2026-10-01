import { MailError } from "../errors.ts";
import type { Rule, RuleAction, RulesDocument } from "./types.ts";
import { assertShadowedFirst, parseRulesDocument, ruleFingerprint } from "./validate.ts";

/** Jon's session only (the API enforces it). `live` means autoSend for a reply and auto for an unsubscribe. */
export type AutomationMode = "draft" | "shadow" | "live";

function find(doc: RulesDocument, ruleId: string, sha256: unknown): Rule {
  const rule = doc.rules.find((item) => item.id === ruleId);
  if (!rule) throw new MailError(`No rule ${ruleId}`, "not_found");
  if (typeof sha256 !== "string" || sha256 !== ruleFingerprint(rule)) {
    throw new MailError(`Rule ${ruleId} changed since you looked at it. Review it again.`, "conflict");
  }
  return rule;
}

/** Re-validates and stamps the changed rule as Jon's: from here on, a bot can no longer edit it. */
function save(previous: RulesDocument, rules: Rule[], at: Date): RulesDocument {
  const next = parseRulesDocument({ ...previous, rules }, "human", at, previous);
  assertShadowedFirst(previous, next);
  return next;
}

/** Turns a rule on, exactly as reviewed. Enabling a bot's proposal makes it Jon's rule. */
export function enableRule(previous: RulesDocument, ruleId: string, sha256: unknown, at: Date): RulesDocument {
  const rule = find(previous, ruleId, sha256);
  const next = save(previous, previous.rules.map((item) => (item.id === ruleId ? { ...rule, enabled: true } : item)), at);
  return { ...next, rules: next.rules.map((item) => (item.id === ruleId ? { ...item, createdBy: "human" } : item)) };
}

function withMode(action: RuleAction, mode: AutomationMode, ruleId: string): RuleAction {
  switch (action.type) {
    case "reply":
      return { ...action, reply: { ...action.reply, mode: mode === "live" ? "autoSend" : mode } };
    case "unsubscribe":
      if (mode === "draft") throw new MailError(`Rule ${ruleId}: an unsubscribe is shadow or live; disable the rule to stop it`, "invalid");
      return { ...action, unsubscribe: { ...action.unsubscribe, mode: mode === "live" ? "auto" : "shadow" } };
    case "label":
    case "move":
    case "markRead":
    case "trash":
      return action;
    default: {
      const unexpected: never = action;
      throw new Error(`Unknown action ${String(unexpected)}`);
    }
  }
}

/** Moves a rule's reply or unsubscribe between draft, shadow and live. Live needs the stored rule to be in shadow already. */
export function setAutomationMode(previous: RulesDocument, ruleId: string, mode: AutomationMode, sha256: unknown, at: Date): RulesDocument {
  const rule = find(previous, ruleId, sha256);
  if (!rule.actions.some((action) => action.type === "reply" || action.type === "unsubscribe")) {
    throw new MailError(`Rule ${ruleId} has no reply or unsubscribe action`, "invalid");
  }
  const changed: Rule = { ...rule, actions: rule.actions.map((action) => withMode(action, mode, ruleId)) };
  const next = save(previous, previous.rules.map((item) => (item.id === ruleId ? changed : item)), at);
  return { ...next, rules: next.rules.map((item) => (item.id === ruleId ? { ...item, createdBy: "human" } : item)) };
}

export function isAutomationMode(value: unknown): value is AutomationMode {
  return value === "draft" || value === "shadow" || value === "live";
}

/** Per-rule fingerprints for GET /v1/rules, so a client can enable exactly the version it shows. */
export function ruleFingerprints(doc: RulesDocument): Record<string, string> {
  return Object.fromEntries(doc.rules.map((rule) => [rule.id, ruleFingerprint(rule)]));
}
