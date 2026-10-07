import { MailError } from "../errors.ts";
import type { StoredMessage } from "../types.ts";
import { siRuleId } from "./ids.ts";
import { SI_ACTION_TYPES, type SiAction, type SiApplyItem, type SiProposal } from "./types.ts";

const LABEL = /^[a-z0-9][a-z0-9 _./-]{0,39}$/;
const HARD_DELETE = new Set(["delete", "harddelete", "hard-delete", "remove", "purge", "expunge"]);

export interface SiMailRef {
  id: string;
  from: string;
  domain: string;
  subject: string;
  snippet: string;
  text: string;
  category: string;
  labels: string[];
  bulk: boolean;
  phishingScore: number;
}

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function mailRef(message: StoredMessage, text = ""): SiMailRef {
  return {
    id: message.id,
    from: message.from.email.trim().toLowerCase(),
    domain: domainOf(message.from.email),
    subject: message.subject,
    snippet: message.snippet ?? "",
    text: text.slice(0, 1500),
    category: message.ai?.category ?? "",
    labels: message.labels,
    bulk: message.bulk,
    phishingScore: message.ai?.phishingScore ?? 0,
  };
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim().toLowerCase();
  if (label === "flagged" || !LABEL.test(label)) return null;
  return label;
}

/**
 * Turns model JSON into proposals. A permanent-delete action is rewritten to
 * Trash. Unknown actions are dropped. Message ids the model invents are ignored.
 */
export function parseSiModelOutput(text: string, messages: readonly SiMailRef[]): SiProposal[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new MailError("SI did not return JSON", "upstream");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new MailError("SI returned malformed JSON", "upstream");
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new MailError("SI JSON has no items", "upstream");
  const byId = new Map(messages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const proposals: SiProposal[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { messageId?: unknown; reason?: unknown; actions?: unknown; saveRule?: unknown };
    if (typeof row.messageId !== "string" || !byId.has(row.messageId) || seen.has(row.messageId)) continue;
    seen.add(row.messageId);
    const message = byId.get(row.messageId);
    if (!message) continue;
    proposals.push({
      messageId: message.id,
      from: message.from,
      domain: message.domain,
      subject: message.subject,
      reason: typeof row.reason === "string" ? row.reason.trim().slice(0, 240) : "",
      actions: sanitizeActions(row.actions, message),
      saveRule: row.saveRule === true,
    });
  }
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    proposals.push({
      messageId: message.id,
      from: message.from,
      domain: message.domain,
      subject: message.subject,
      reason: "SI left this for you.",
      actions: [],
      saveRule: false,
    });
  }
  return proposals;
}

/** Drops anything that is not a filing action. `delete` becomes Trash. */
export function sanitizeActions(input: unknown, message: Pick<SiMailRef, "from" | "domain">): SiAction[] {
  if (!Array.isArray(input)) return [];
  const actions: SiAction[] = [];
  const labels = new Set<string>();
  let spam = false;
  let trash = false;
  let blockSender = false;
  let blockDomain = false;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    let type = String((raw as { type?: unknown }).type ?? "").trim();
    if (HARD_DELETE.has(type.toLowerCase())) type = "trash";
    if (!(SI_ACTION_TYPES as readonly string[]).includes(type)) continue;
    switch (type) {
      case "label": {
        const listed = (raw as { labels?: unknown }).labels;
        if (!Array.isArray(listed)) break;
        for (const label of listed) {
          const cleaned = cleanLabel(label);
          if (cleaned) labels.add(cleaned);
        }
        break;
      }
      case "spam":
        spam = true;
        break;
      case "trash":
        trash = true;
        break;
      case "blockSender":
        if (message.from.includes("@")) blockSender = true;
        break;
      case "blockDomain":
        if (message.domain.includes(".")) blockDomain = true;
        break;
      default: {
        const unexpected: never = type as never;
        throw new Error(`Unhandled SI action ${String(unexpected)}`);
      }
    }
  }
  if (labels.size > 0) actions.push({ type: "label", labels: [...labels] });
  if (trash) actions.push({ type: "trash" });
  else if (spam) actions.push({ type: "spam" });
  if (blockSender) actions.push({ type: "blockSender" });
  if (blockDomain) actions.push({ type: "blockDomain" });
  return actions;
}

/** Used when the model is off or its JSON is unusable. It only files the obvious cases. */
export function heuristicProposals(messages: readonly SiMailRef[]): SiProposal[] {
  return messages.map((message) => {
    const actions: SiAction[] = [];
    const subject = `${message.subject} ${message.snippet}`.toLowerCase();
    if (message.category === "newsletter" || message.bulk) actions.push({ type: "label", labels: ["newsletters"] });
    if (message.category === "transactional" || /receipt|invoice|order confirmation/.test(subject)) {
      actions.push({ type: "label", labels: ["receipts"] });
    }
    if (message.category === "phishing" || message.phishingScore >= 40) actions.push({ type: "spam" });
    const reason = actions.length === 0 ? "SI left this for you." : "Filed from the category already on the message.";
    return {
      messageId: message.id,
      from: message.from,
      domain: message.domain,
      subject: message.subject,
      reason,
      actions: sanitizeActions(actions, message),
      saveRule: false,
    };
  });
}

export function parseApplyItems(input: unknown): SiApplyItem[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as { items?: unknown }).items)) {
    throw new MailError("items is required", "invalid");
  }
  const items: SiApplyItem[] = [];
  for (const raw of (input as { items: unknown[] }).items) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { messageId?: unknown; actions?: unknown; saveRule?: unknown };
    if (typeof row.messageId !== "string" || !row.messageId) continue;
    items.push({
      messageId: row.messageId,
      actions: [],
      saveRule: row.saveRule === true,
    });
    const last = items[items.length - 1];
    if (!last) continue;
    last.actions = sanitizeActions(row.actions, { from: "pending@example.com", domain: "example.com" });
  }
  return items;
}

/**
 * Re-checks actions against the stored sender. A client cannot block an address
 * that did not send the message, and cannot smuggle a delete.
 */
export function actionsForMessage(actions: SiAction[], message: SiMailRef, own: { mailbox: string; domain: string }): SiAction[] {
  const ownMailbox = own.mailbox.trim().toLowerCase();
  const ownDomain = own.domain.trim().toLowerCase();
  return sanitizeActions(actions, message).filter((action) => {
    if (action.type === "blockSender" && message.from === ownMailbox) return false;
    if (action.type === "blockDomain" && message.domain === ownDomain) return false;
    return true;
  });
}

export interface FilingDraft {
  id: string;
  name: string;
  enabled: boolean;
  match: { from: string[] };
  actions: Array<{ type: "label"; labels: string[] } | { type: "move"; folder: "spam" } | { type: "trash" }>;
  stop: boolean;
}

/** A block is a mail rule: matching mail is moved to Trash, which stays restorable. */
export function blockRule(action: Extract<SiAction, { type: "blockSender" | "blockDomain" }>, message: SiMailRef): FilingDraft {
  if (action.type === "blockSender") {
    return {
      id: siRuleId("block-sender", message.from),
      name: `SI block ${message.from}`.slice(0, 120),
      enabled: true,
      match: { from: [message.from] },
      actions: [{ type: "trash" }],
      stop: true,
    };
  }
  return {
    id: siRuleId("block-domain", message.domain),
    name: `SI block @${message.domain}`.slice(0, 120),
    enabled: true,
    match: { from: [`@${message.domain}`] },
    actions: [{ type: "trash" }],
    stop: true,
  };
}

/** Label, junk, or trash for later mail from this sender. No reply and no auto-send. */
export function savedFilingRule(actions: readonly SiAction[], message: SiMailRef): FilingDraft | null {
  const labels = actions.flatMap((action) => (action.type === "label" ? action.labels : []));
  const trash = actions.some((action) => action.type === "trash");
  const spam = actions.some((action) => action.type === "spam");
  const filing: FilingDraft["actions"] = [];
  if (labels.length > 0) filing.push({ type: "label", labels });
  if (trash) filing.push({ type: "trash" });
  else if (spam) filing.push({ type: "move", folder: "spam" });
  if (filing.length === 0) return null;
  const kind = labels[0] ?? (trash ? "trash" : "spam");
  return {
    id: siRuleId("file", `${message.from}-${kind}`),
    name: `SI file ${message.from}`.slice(0, 120),
    enabled: true,
    match: { from: [message.from] },
    actions: filing,
    stop: false,
  };
}
