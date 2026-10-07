import { z } from "zod";
import { MailError } from "../errors.ts";
import { sha256 } from "../ids.ts";
import type { Category, Priority } from "../types.ts";
import { RULE_FOLDERS, type Rule, type RuleAuthor, type RulesDocument } from "./types.ts";

const CATEGORIES = ["personal", "transactional", "newsletter", "notification", "phishing", "other"] as const satisfies readonly Category[];
const PRIORITIES = ["now", "today", "later", "noise"] as const satisfies readonly Priority[];

export const MAX_RULES = 200;
export const REPLY_MAX_CHARS = 1500;
export const PER_SENDER_PER_DAY_MAX = 5;
export const PER_DAY_MAX = 50;
export const GLOBAL_PER_DAY_MAX = 100;
export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 365;

const senderPattern = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^([^\s@<>"]+@|@)[a-z0-9.-]+\.[a-z]{2,}$/, "must be an address or @domain");
const label = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9 _./-]{0,39}$/, "labels are 1-40 of a-z 0-9 space _ . / -");
const needle = z.string().trim().min(1).max(200);

const matchSchema = z
  .object({
    from: z.array(senderPattern).max(500).optional(),
    to: z.array(senderPattern).max(50).optional(),
    subjectContains: z.array(needle).max(50).optional(),
    listId: z.array(needle).max(50).optional(),
    categories: z.array(z.enum(CATEGORIES)).optional(),
    priorities: z.array(z.enum(PRIORITIES)).optional(),
    aiLabels: z.array(label).max(50).optional(),
    bulk: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
  })
  .strict()
  .refine((match) => Object.values(match).some((value) => value !== undefined && (!Array.isArray(value) || value.length > 0)), {
    message: "a rule needs at least one match condition; catch-all rules are refused",
  });

const replySchema = z
  .object({
    mode: z.enum(["draft", "shadow", "autoSend"]).default("draft"),
    template: z.string().trim().min(1).max(REPLY_MAX_CHARS).optional(),
    ai: z.object({ instruction: z.string().trim().min(1).max(1000) }).strict().optional(),
    allowAiText: z.boolean().default(false),
    maxChars: z.number().int().min(40).max(REPLY_MAX_CHARS).default(600),
    allowSenders: z.array(senderPattern).max(500).default([]),
    allowCategories: z.array(z.enum(CATEGORIES)).default([]),
    perSenderPerDay: z.number().int().min(1).max(PER_SENDER_PER_DAY_MAX).default(1),
    perDay: z.number().int().min(1).max(PER_DAY_MAX).default(10),
  })
  .strict()
  .superRefine((reply, ctx) => {
    if (Boolean(reply.template) === Boolean(reply.ai)) ctx.addIssue({ code: "custom", message: "set exactly one of template and ai" });
    const automated = reply.mode !== "draft";
    if (automated && reply.allowSenders.length === 0 && !(reply.template && reply.allowCategories.length > 0)) {
      ctx.addIssue({
        code: "custom",
        message: "autoSend and shadow need allowSenders, or a fixed template with allowCategories; model-written text to a category alone is too easy to steer",
      });
    }
    if (automated && reply.allowCategories.includes("phishing")) {
      ctx.addIssue({ code: "custom", message: "autoSend never answers mail classified as phishing" });
    }
    if (reply.mode === "autoSend" && reply.ai && !reply.allowAiText) {
      ctx.addIssue({ code: "custom", message: "autoSend with model-written text needs allowAiText: true on the rule (Jon's explicit opt-in); otherwise use a fixed template" });
    }
  });

export const UNSUBSCRIBE_PER_DAY_MAX = 50;

const unsubscribeSchema = z
  .object({
    mode: z.enum(["shadow", "auto"]).default("shadow"),
    allowSenders: z.array(senderPattern).max(500).default([]),
    perDay: z.number().int().min(1).max(UNSUBSCRIBE_PER_DAY_MAX).default(10),
  })
  .strict();

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("label"), labels: z.array(label).min(1).max(20) }).strict(),
  z.object({ type: z.literal("move"), folder: z.enum(RULE_FOLDERS) }).strict(),
  z.object({ type: z.literal("markRead") }).strict(),
  z.object({ type: z.literal("trash") }).strict(),
  z.object({ type: z.literal("reply"), reply: replySchema }).strict(),
  z.object({ type: z.literal("unsubscribe"), unsubscribe: unsubscribeSchema }).strict(),
]);

const ruleSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "rule ids are 1-64 of a-z 0-9 -"),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    match: matchSchema,
    actions: z.array(actionSchema).min(1).max(10),
    stop: z.boolean().default(false),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const types = rule.actions.map((action) => action.type);
    if (types.filter((type) => type === "reply").length > 1) ctx.addIssue({ code: "custom", message: "one reply per rule" });
    if (types.filter((type) => type === "move" || type === "trash").length > 1) {
      ctx.addIssue({ code: "custom", message: "one move or trash per rule" });
    }
    if (types.includes("trash") && types.includes("reply")) ctx.addIssue({ code: "custom", message: "a rule cannot both reply and trash" });
    if (types.filter((type) => type === "unsubscribe").length > 1) ctx.addIssue({ code: "custom", message: "one unsubscribe per rule" });
    if (types.includes("unsubscribe") && types.includes("reply")) ctx.addIssue({ code: "custom", message: "a rule cannot both reply and unsubscribe" });
  });

const documentSchema = z
  .object({
    version: z.literal(1).default(1),
    paused: z.boolean().default(false),
    killSwitch: z.boolean().default(false),
    sendKillSwitch: z.boolean().default(false),
    siKillSwitch: z.boolean().optional(),
    trashRetentionDays: z.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS).default(30),
    maxAutoSendPerDay: z.number().int().min(1).max(GLOBAL_PER_DAY_MAX).default(20),
    rules: z.array(ruleSchema).max(MAX_RULES),
  })
  .strip()
  .superRefine((doc, ctx) => {
    const ids = doc.rules.map((rule) => rule.id);
    const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (dupes.length > 0) ctx.addIssue({ code: "custom", message: `duplicate rule ids: ${[...new Set(dupes)].join(", ")}` });
  });

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "rules"}: ${issue.message}`)
    .join("; ");
}

/**
 * Parses a rules file or API body. Author fields are stamped here from the
 * caller's principal; anything the input says about authorship is dropped.
 */
export function parseRulesDocument(input: unknown, author: RuleAuthor, at: Date, previous: RulesDocument | null = null): RulesDocument {
  const parsed = documentSchema.safeParse(withoutAuthorship(input));
  if (!parsed.success) throw new MailError(`Invalid rules: ${issues(parsed.error)}`, "invalid");
  const now = at.toISOString();
  const before = new Map((previous?.rules ?? []).map((rule) => [rule.id, rule]));
  const rules: Rule[] = parsed.data.rules.map((rule) => {
    const prior = before.get(rule.id);
    const unchanged = prior && ruleFingerprint(prior) === ruleFingerprint({ ...rule, createdBy: prior.createdBy, updatedAt: prior.updatedAt });
    return { ...rule, createdBy: unchanged ? prior.createdBy : author, updatedAt: unchanged ? prior.updatedAt : now } as Rule;
  });
  return {
    ...parsed.data,
    siKillSwitch: parsed.data.siKillSwitch ?? previous?.siKillSwitch ?? false,
    rules,
    updatedAt: now,
    updatedBy: author,
  };
}

/** Parses without stamping, for `npm run rules -- validate` and dry runs. */
export function checkRulesFile(input: unknown): { ok: true; rules: number } | { ok: false; error: string } {
  const parsed = documentSchema.safeParse(withoutAuthorship(input));
  return parsed.success ? { ok: true, rules: parsed.data.rules.length } : { ok: false, error: issues(parsed.error) };
}

/** A document fetched with GET carries authorship; it is always re-stamped, never trusted. */
function withoutAuthorship(input: unknown): unknown {
  if (!input || typeof input !== "object" || !("rules" in input) || !Array.isArray(input.rules)) return input;
  const rules = input.rules.map((rule: unknown) => {
    if (!rule || typeof rule !== "object") return rule;
    const { createdBy: _c, updatedAt: _u, ...rest } = rule as Record<string, unknown>;
    return rest;
  });
  return { ...input, rules };
}

/** What a rule does, without who wrote it or when. Jon enables or promotes a rule by this hash, so he enables exactly what he reviewed. */
export function ruleFingerprint(rule: Rule): string {
  const { createdBy: _c, updatedAt: _u, ...rest } = rule;
  return sha256(JSON.stringify(rest));
}

/** `shadow`, `live` or null for each automated action: an auto-send reply or an unsubscribe. */
export function automationModes(rule: Rule): Array<{ type: "reply" | "unsubscribe"; live: boolean }> {
  const out: Array<{ type: "reply" | "unsubscribe"; live: boolean }> = [];
  for (const action of rule.actions) {
    if (action.type === "reply" && action.reply.mode !== "draft") out.push({ type: "reply", live: action.reply.mode === "autoSend" });
    if (action.type === "unsubscribe") out.push({ type: "unsubscribe", live: action.unsubscribe.mode === "auto" });
  }
  return out;
}

/**
 * Shadow first: an automated action may go live only if the stored rule with
 * the same id already ran that action in shadow (or live) mode. Jon's session
 * paths call this; nothing else can make an action live.
 */
export function assertShadowedFirst(previous: RulesDocument | null, next: RulesDocument): void {
  const before = new Map((previous?.rules ?? []).map((rule) => [rule.id, rule]));
  for (const rule of next.rules) {
    for (const mode of automationModes(rule)) {
      if (!mode.live) continue;
      const prior = before.get(rule.id);
      if (!prior || !automationModes(prior).some((item) => item.type === mode.type)) {
        throw new MailError(`Rule ${rule.id}: run its ${mode.type === "reply" ? "auto-reply" : "unsubscribe"} in shadow mode first, check what it would have sent, then make it live`, "invalid");
      }
    }
  }
}

/** A stable hash of what the rules do, for the audit log. */
export function rulesHash(doc: RulesDocument): string {
  const { updatedAt: _u, updatedBy: _b, ...rest } = doc;
  return sha256(JSON.stringify({ ...rest, rules: rest.rules.map(({ updatedAt: _t, ...rule }) => rule) }));
}

export function emptyRules(at: Date): RulesDocument {
  return {
    version: 1,
    paused: false,
    killSwitch: false,
    sendKillSwitch: false,
    siKillSwitch: false,
    trashRetentionDays: 30,
    maxAutoSendPerDay: 20,
    rules: [],
    updatedAt: at.toISOString(),
    updatedBy: "human",
  };
}
