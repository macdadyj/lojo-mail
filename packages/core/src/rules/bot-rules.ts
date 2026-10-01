import { MailError } from "../errors.ts";
import type { Rule, RulesDocument } from "./types.ts";
import { parseRulesDocument } from "./validate.ts";

/**
 * Bots sort mail with rules of their own. They can add, edit and delete only
 * rules a bot wrote; Jon's rules are read-only to them apart from disabling.
 * A bot rule can label, move, mark read, or reply as a draft for Jon to approve,
 * never auto-send and never trash. The document's switches and limits are untouched.
 */
function refusals(rule: Rule): string[] {
  const out: string[] = [];
  for (const action of rule.actions) {
    if (action.type === "trash") out.push("bot rules cannot move mail to Trash; use the trash tool, which is capped per day");
    if (action.type === "reply" && action.reply.mode === "autoSend") out.push("bot rules cannot auto-send; replies stay drafts for Jon");
  }
  return out;
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
