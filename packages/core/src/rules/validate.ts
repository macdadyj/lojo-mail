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
    mode: z.enum(["draft", "autoSend"]).default("draft"),
    template: z.string().trim().min(1).max(REPLY_MAX_CHARS).optional(),
    ai: z.object({ instruction: z.string().trim().min(1).max(1000) }).strict().optional(),
    maxChars: z.number().int().min(40).max(REPLY_MAX_CHARS).default(600),
    allowSenders: z.array(senderPattern).max(500).default([]),
    allowCategories: z.array(z.enum(CATEGORIES)).default([]),
    perSenderPerDay: z.number().int().min(1).max(PER_SENDER_PER_DAY_MAX).default(1),
    perDay: z.number().int().min(1).max(PER_DAY_MAX).default(10),
  })
  .strict()
  .superRefine((reply, ctx) => {
    if (Boolean(reply.template) === Boolean(reply.ai)) ctx.addIssue({ code: "custom", message: "set exactly one of template and ai" });
    if (reply.mode === "autoSend" && reply.allowSenders.length === 0) {
      ctx.addIssue({ code: "custom", message: "autoSend needs allowSenders; categories alone are model output an email can steer" });
    }
    if (reply.mode === "autoSend" && reply.allowCategories.includes("phishing")) {
      ctx.addIssue({ code: "custom", message: "autoSend never answers mail classified as phishing" });
    }
  });

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("label"), labels: z.array(label).min(1).max(20) }).strict(),
  z.object({ type: z.literal("move"), folder: z.enum(RULE_FOLDERS) }).strict(),
  z.object({ type: z.literal("markRead") }).strict(),
  z.object({ type: z.literal("trash") }).strict(),
  z.object({ type: z.literal("reply"), reply: replySchema }).strict(),
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
  });

const documentSchema = z
  .object({
    version: z.literal(1).default(1),
    paused: z.boolean().default(false),
    killSwitch: z.boolean().default(false),
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
  return { ...parsed.data, rules, updatedAt: now, updatedBy: author };
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

function ruleFingerprint(rule: Rule): string {
  const { createdBy: _c, updatedAt: _u, ...rest } = rule;
  return sha256(JSON.stringify(rest));
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
    trashRetentionDays: 30,
    maxAutoSendPerDay: 20,
    rules: [],
    updatedAt: at.toISOString(),
    updatedBy: "human",
  };
}
