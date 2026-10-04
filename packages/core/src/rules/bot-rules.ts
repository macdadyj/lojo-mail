import { MailError } from "../errors.ts";
import type { Rule, RulesDocument } from "./types.ts";
import { automationModes, parseRulesDocument } from "./validate.ts";

/**
 * Assistants sort mail with rules of their own. A bot credential or an agent
 * token with `rules` can add, edit and delete only rules an assistant wrote
 * (`createdBy: bot`); Jon's rules stay read-only apart from disabling.
 * Filing actions, including trash, take effect immediately. Trash is the
 * engine's soft delete: the message stays restorable for `trashRetentionDays`.
 * Auto-send and live unsubscribe are refused. A shadow reply or shadow
 * unsubscribe is saved disabled, and only Jon's session can enable it or make
 * it live. The document's switches and limits are untouched.
 */
function refusals(rule: Rule): string[] {
  const out: string[] = [];
  for (const action of rule.actions) {
    if (action.type === "reply" && action.reply.mode === "autoSend") out.push("assistant rules cannot auto-send; use mode shadow and Jon makes it live");
    if (action.type === "unsubscribe" && action.unsubscribe.mode === "auto") out.push("assistant rules cannot unsubscribe by themselves; use mode shadow and Jon makes it live");
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
    throw new MailError(`Rule ${ruleId} is Jon's. Assistants can only disable it (POST /v1/rules/${ruleId}/disable).`, "forbidden");
  }
}

/**
 * A human rules file is the source of truth for Jon's rules only. Assistant
 * rules (`createdBy: bot`) are kept, in their previous order, after the file's
 * rules. An id in the file that an assistant already owns is ignored, so a
 * push cannot overwrite or delete those rules.
 */
export function preserveBotRules(previous: RulesDocument | null, input: unknown): unknown {
  if (!previous || !input || typeof input !== "object" || Array.isArray(input)) return input;
  const body = input as Record<string, unknown>;
  if (!Array.isArray(body.rules)) return input;
  const botOwned = previous.rules.filter((rule) => rule.createdBy === "bot");
  if (botOwned.length === 0) return input;
  const ids = new Set(botOwned.map((rule) => rule.id));
  const human = body.rules.filter((rule) => {
    if (!rule || typeof rule !== "object") return true;
    const id = (rule as { id?: unknown }).id;
    return typeof id !== "string" || !ids.has(id);
  });
  const kept = botOwned.map((rule) => {
    const { createdBy: _createdBy, updatedAt: _updatedAt, ...rest } = rule;
    return rest;
  });
  return { ...body, rules: [...human, ...kept] };
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
