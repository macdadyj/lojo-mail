import { MailError } from "../errors.ts";
import type { Rule, RulesDocument } from "./types.ts";
import { automationModes, parseRulesDocument } from "./validate.ts";

/**
 * Bots sort mail with rules of their own. They can add, edit and delete only
 * rules a bot wrote; Jon's rules are read-only to them apart from disabling.
 * A bot rule can label, move, mark read, or reply as a draft for Jon to approve,
 * never auto-send and never trash. It may also propose an automated rule (a
 * shadow auto-reply or unsubscribe): that is always saved disabled, and only
 * Jon's session can enable it or make it live (POST /v1/rules/:id/enable, /automation).
 * The document's switches and limits are untouched.
 */
function refusals(rule: Rule): string[] {
  const out: string[] = [];
  for (const action of rule.actions) {
    if (action.type === "trash") out.push("bot rules cannot move mail to Trash; use the trash tool, which is capped per day");
    if (action.type === "reply" && action.reply.mode === "autoSend") out.push("bot rules cannot auto-send; propose it with mode shadow and Jon makes it live");
    if (action.type === "unsubscribe" && action.unsubscribe.mode === "auto") out.push("bot rules cannot unsubscribe by themselves; propose it with mode shadow and Jon makes it live");
  }
  return out;
}

/** A proposal: a bot rule whose actions would act outside the mailbox if Jon enabled it. */
export function isProposal(rule: Rule): boolean {
  return automationModes(rule).length > 0;
}

function ownedByBot(previous: RulesDocument, ruleId: string): void {
  const prior = previous.rules.find((rule) => rule.id === ruleId);
  if (prior && prior.createdBy !== "bot") {
    throw new MailError(`Rule ${ruleId} is Jon's. Bots can only disable it (POST /v1/rules/${ruleId}/disable).`, "forbidden");
  }
}

/** Adds or replaces one rule by id. Returns the new document; the caller saves it. */
export function upsertBotRule(previous: RulesDocument, input: unknown, at: Date): RulesDocument {
  const id = (input as { id?: unknown } | null)?.id;
  if (typeof id !== "string") throw new MailError("rule.id is required", "invalid");
  ownedByBot(previous, id);
  const exists = previous.rules.some((rule) => rule.id === id);
  const rules = exists ? previous.rules.map((rule) => (rule.id === id ? input : rule)) : [...previous.rules, input];
  const next = parseRulesDocument({ ...previous, rules }, "bot", at, previous);
  const written = next.rules.find((rule) => rule.id === id);
  if (!written) throw new Error(`rule ${id} vanished`);
  const refused = refusals(written);
  if (refused.length > 0) throw new MailError(refused.join("; "), "forbidden");
  return {
    ...next,
    rules: next.rules.map((rule) => (rule.id === id && isProposal(rule) ? { ...rule, enabled: false } : rule)),
    paused: previous.paused,
    killSwitch: previous.killSwitch,
    sendKillSwitch: previous.sendKillSwitch,
    trashRetentionDays: previous.trashRetentionDays,
    maxAutoSendPerDay: previous.maxAutoSendPerDay,
  };
}

export function deleteBotRule(previous: RulesDocument, ruleId: string, at: Date): RulesDocument {
  if (!previous.rules.some((rule) => rule.id === ruleId)) throw new MailError(`No rule ${ruleId}`, "not_found");
  ownedByBot(previous, ruleId);
  return { ...previous, rules: previous.rules.filter((rule) => rule.id !== ruleId), updatedAt: at.toISOString(), updatedBy: "bot" };
}
