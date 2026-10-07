import type { LlmClient } from "../ai/types.ts";
import type { BlobStore } from "../blob/store.ts";
import { rulesContext, serverOpen, serverSeal, type KeyWrapper } from "../crypto/server-seal.ts";
import { MailError } from "../errors.ts";
import { newId, utcDay } from "../ids.ts";
import { saveRules } from "../rules/engine.ts";
import type { Rule, RulesDocument } from "../rules/types.ts";
import { parseRulesDocument, ruleFingerprint } from "../rules/validate.ts";
import type { MailStore } from "../store/types.ts";
import type { Folder, LojoConfig, ServerSealedBlob, StoredMessage } from "../types.ts";
import { isSiBlockId, isSiRuleId } from "./ids.ts";
import {
  actionsForMessage,
  blockRule,
  heuristicProposals,
  mailRef,
  parseApplyItems,
  parseSiModelOutput,
  savedFilingRule,
  type FilingDraft,
  type SiMailRef,
} from "./parse.ts";
import { FILTER_SYSTEM, filterUser, replySystem, replyUser, toneOf } from "./prompt.ts";
import type { SiAction, SiApplyResult, SiBlock, SiChange, SiFilterResult, SiLedger, SiRuleChange } from "./types.ts";

/** Sealed with the rules purpose, under the rules prefix, so the API role can write it without a new grant. */
export const SI_LEDGER_KEY = "rules/si-ledger.bin";
export const SI_FILTER_LIMIT = 25;
const LEDGER_CAP = 20;

export interface SiHost {
  now(): Date;
  llm: LlmClient | null;
  config: Pick<LojoConfig, "mailbox" | "domain" | "dailyTokenBudget">;
  store: MailStore;
  blobs: BlobStore;
  keys: KeyWrapper;
  getRules(): Promise<RulesDocument>;
  trash(messageId: string): Promise<StoredMessage>;
  move(messageId: string, folder: Folder): Promise<StoredMessage>;
  setLabels(messageId: string, labels: string[]): Promise<StoredMessage>;
  setUnread(messageId: string, unread: boolean): Promise<StoredMessage>;
  audit(action: string, outcome: string, extra?: { messageId?: string; detail?: string }): Promise<void>;
}

function ownOf(host: SiHost): { mailbox: string; domain: string } {
  return { mailbox: host.config.mailbox, domain: host.config.domain };
}

async function requireBudget(host: SiHost): Promise<void> {
  const used = await host.store.getBudget(utcDay(host.now()));
  if (used >= host.config.dailyTokenBudget) throw new MailError("Daily token budget is spent", "budget");
}

async function loadLedger(host: SiHost): Promise<SiLedger> {
  const bytes = await host.blobs.get(SI_LEDGER_KEY);
  if (!bytes) return { version: 1, changes: [] };
  const sealed = JSON.parse(new TextDecoder().decode(bytes)) as ServerSealedBlob;
  const ledger = await serverOpen<SiLedger>(sealed, rulesContext(), host.keys);
  return ledger.version === 1 && Array.isArray(ledger.changes) ? ledger : { version: 1, changes: [] };
}

async function saveLedger(host: SiHost, ledger: SiLedger): Promise<void> {
  const sealed = await serverSeal(ledger, rulesContext(), host.keys);
  await host.blobs.put(SI_LEDGER_KEY, new TextEncoder().encode(JSON.stringify(sealed)), "application/json");
}

function textsOf(input: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!input || typeof input !== "object") return out;
  const texts = (input as { texts?: unknown }).texts;
  if (!texts || typeof texts !== "object" || Array.isArray(texts)) return out;
  for (const [id, text] of Object.entries(texts)) {
    if (typeof text === "string" && text.trim()) out.set(id, text.slice(0, 1500));
  }
  return out;
}

async function resolveMessages(host: SiHost, input: unknown): Promise<StoredMessage[]> {
  if (!input || typeof input !== "object") throw new MailError("Send messageIds or a folder", "invalid");
  const body = input as { messageIds?: unknown; folder?: unknown };
  if (Array.isArray(body.messageIds) && body.messageIds.length > 0) {
    if (body.messageIds.length > SI_FILTER_LIMIT) throw new MailError(`SI filters at most ${SI_FILTER_LIMIT} messages at once`, "invalid");
    const messages: StoredMessage[] = [];
    for (const id of body.messageIds) {
      if (typeof id !== "string" || !id) throw new MailError("messageIds must be strings", "invalid");
      const message = await host.store.getMessage(id);
      if (!message) throw new MailError(`No message ${id}`, "not_found");
      if (message.folder === "drafts") continue;
      messages.push(message);
    }
    return messages;
  }
  const folder = body.folder === undefined ? "inbox" : body.folder;
  if (folder !== "inbox" && folder !== "archive" && folder !== "spam" && folder !== "trash" && folder !== "sent") {
    throw new MailError("folder must be inbox, archive, spam, trash, or sent", "invalid");
  }
  const listed = await host.store.listMessages({ folder, limit: SI_FILTER_LIMIT });
  return listed.filter((message) => message.folder !== "drafts").slice(0, SI_FILTER_LIMIT);
}

function refsFor(messages: readonly StoredMessage[], texts: Map<string, string>): SiMailRef[] {
  return messages.map((message) => mailRef(message, texts.get(message.id) ?? message.snippet ?? ""));
}

/** Proposes filing actions. It does not change mail. */
export async function proposeSiFilter(host: SiHost, input: unknown): Promise<SiFilterResult> {
  const doc = await host.getRules();
  const messages = await resolveMessages(host, input);
  const refs = refsFor(messages, textsOf(input));
  if (refs.length === 0) return { killSwitch: doc.siKillSwitch === true, proposals: [] };
  const llm = host.llm;
  if (!llm) return { killSwitch: doc.siKillSwitch === true, proposals: heuristicProposals(refs) };
  await requireBudget(host);
  const user = filterUser(refs);
  try {
    const completion = await llm.complete({ system: FILTER_SYSTEM, user, maxTokens: 1200, temperature: 0 });
    await host.store.addBudget(utcDay(host.now()), completion.inputTokens + completion.outputTokens);
    const proposals = parseSiModelOutput(completion.text, refs);
    await host.audit("si.filter", "ok", { detail: `messages:${refs.length}` });
    return { killSwitch: doc.siKillSwitch === true, proposals };
  } catch (error) {
    if (error instanceof MailError && error.code === "budget") throw error;
    const detail = (error instanceof Error ? error.message : "model call failed").slice(0, 200);
    await host.audit("si.filter", "bad_output", { detail });
    return { killSwitch: doc.siKillSwitch === true, proposals: heuristicProposals(refs) };
  }
}

function filingFolder(actions: readonly SiAction[]): "trash" | "spam" | null {
  if (actions.some((action) => action.type === "trash")) return "trash";
  if (actions.some((action) => action.type === "spam")) return "spam";
  return null;
}

function upsertFiling(doc: RulesDocument, draft: FilingDraft, at: Date): { doc: RulesDocument; change: SiRuleChange } {
  const before = doc.rules.find((rule) => rule.id === draft.id) ?? null;
  if (before && before.createdBy === "bot") {
    throw new MailError(`Rule ${draft.id} belongs to an assistant. SI will not overwrite it.`, "forbidden");
  }
  if (before && !isSiRuleId(before.id)) {
    throw new MailError(`Rule ${draft.id} is not an SI rule`, "forbidden");
  }
  const rules = before ? doc.rules.map((rule) => (rule.id === draft.id ? draft : rule)) : [...doc.rules, draft];
  const next = parseRulesDocument({ ...doc, rules }, "human", at, doc);
  const after = next.rules.find((rule) => rule.id === draft.id);
  if (!after) throw new MailError(`Rule ${draft.id} was refused`, "invalid");
  if (after.actions.some((action) => action.type === "reply" || action.type === "unsubscribe")) {
    throw new MailError("SI filters only file mail. They never send.", "forbidden");
  }
  return { doc: next, change: { id: draft.id, before, after } };
}

/**
 * Applies the actions Jon confirmed. Trash is the mailbox soft delete.
 * Blocks and optional "save as a rule" go through the mail-rules engine.
 */
export async function applySiFilter(host: SiHost, input: unknown): Promise<SiApplyResult> {
  const doc = await host.getRules();
  if (doc.siKillSwitch === true) throw new MailError("SI filters are stopped", "forbidden");
  const items = parseApplyItems(input);
  if (items.length === 0) throw new MailError("Nothing to apply", "invalid");
  if (items.length > SI_FILTER_LIMIT) throw new MailError(`SI filters at most ${SI_FILTER_LIMIT} messages at once`, "invalid");

  const change: SiChange = { id: newId("sic"), at: host.now().toISOString(), messages: [], rules: [] };
  let rules = doc;
  for (const item of items) {
    const stored = await host.store.getMessage(item.messageId);
    if (!stored) throw new MailError(`No message ${item.messageId}`, "not_found");
    if (stored.folder === "drafts") continue;
    const ref = mailRef(stored);
    const actions = actionsForMessage(item.actions, ref, ownOf(host));
    if (actions.length === 0) continue;
    const before = { folder: stored.folder, labels: [...stored.labels], unread: stored.unread };
    let current = stored;
    const labels = actions.flatMap((action) => (action.type === "label" ? action.labels : []));
    if (labels.length > 0) {
      current = await host.setLabels(current.id, [...new Set([...current.labels, ...labels])]);
    }
    const folder = filingFolder(actions);
    if (folder === "spam" && current.folder !== "spam") current = await host.move(current.id, "spam");
    if (folder === "trash" && current.folder !== "trash") current = await host.trash(current.id);
    change.messages.push({
      messageId: current.id,
      before,
      afterFolder: current.folder,
      afterLabels: [...current.labels],
    });
    for (const action of actions) {
      if (action.type !== "blockSender" && action.type !== "blockDomain") continue;
      const written = upsertFiling(rules, blockRule(action, ref), host.now());
      rules = written.doc;
      change.rules.push(written.change);
    }
    if (item.saveRule) {
      const draft = savedFilingRule(actions, ref);
      if (draft) {
        const written = upsertFiling(rules, draft, host.now());
        rules = written.doc;
        change.rules.push(written.change);
      }
    }
  }
  if (change.messages.length === 0 && change.rules.length === 0) throw new MailError("Nothing to apply", "invalid");
  if (change.rules.length > 0) await saveRules(host.blobs, host.keys, rules);
  const ledger = await loadLedger(host);
  await saveLedger(host, { version: 1, changes: [...ledger.changes, change].slice(-LEDGER_CAP) });
  await host.audit("si.filter_applied", "ok", {
    detail: `change:${change.id} messages:${change.messages.length} rules:${change.rules.length} hardDelete:false`,
  });
  return { changeId: change.id, applied: change.messages.length, rules: change.rules.length, undo: true };
}

function undoOne(rules: Rule[], change: SiRuleChange): Rule[] {
  if (change.after) {
    const current = rules.find((rule) => rule.id === change.id);
    if (!current) return rules;
    if (ruleFingerprint(current) !== ruleFingerprint(change.after)) {
      throw new MailError(`Rule ${change.id} changed since SI wrote it. It was not undone.`, "conflict");
    }
    return change.before ? rules.map((rule) => (rule.id === change.id ? change.before ?? rule : rule)) : rules.filter((rule) => rule.id !== change.id);
  }
  if (change.before) {
    if (rules.some((rule) => rule.id === change.id)) {
      throw new MailError(`Rule ${change.id} is already there. It was not undone.`, "conflict");
    }
    return [...rules, change.before];
  }
  return rules;
}

/** Puts the messages and SI rules back. It never purges a message. */
export async function undoSiChange(host: SiHost, changeId: string): Promise<{ changeId: string; restored: number }> {
  if (!changeId) throw new MailError("changeId is required", "invalid");
  const ledger = await loadLedger(host);
  const change = ledger.changes.find((item) => item.id === changeId);
  if (!change) throw new MailError("That SI change is not in the undo list", "not_found");
  let doc = await host.getRules();
  let rules = doc.rules;
  for (const ruleChange of [...change.rules].reverse()) rules = undoOne(rules, ruleChange);
  doc = { ...doc, rules, updatedAt: host.now().toISOString(), updatedBy: "human" };
  if (change.rules.length > 0) await saveRules(host.blobs, host.keys, doc);
  let restored = 0;
  for (const item of change.messages) {
    const message = await host.store.getMessage(item.messageId);
    if (!message) continue;
    if (message.folder !== item.before.folder) {
      if (item.before.folder === "trash") await host.trash(item.messageId);
      else if (item.before.folder !== "drafts") await host.move(item.messageId, item.before.folder);
    }
    await host.setLabels(item.messageId, item.before.labels);
    await host.setUnread(item.messageId, item.before.unread);
    restored += 1;
  }
  await saveLedger(host, { version: 1, changes: ledger.changes.filter((item) => item.id !== changeId) });
  await host.audit("si.filter_undone", "ok", { detail: `change:${changeId} restored:${restored} hardDelete:false` });
  return { changeId, restored };
}

export async function listBlocked(host: SiHost): Promise<SiBlock[]> {
  const doc = await host.getRules();
  const blocked: SiBlock[] = [];
  for (const rule of doc.rules) {
    if (!rule.enabled || !isSiBlockId(rule.id)) continue;
    const value = rule.match.from?.[0];
    if (!value) continue;
    const kind = rule.id.startsWith("si-block-domain-") ? "domain" : "sender";
    blocked.push({ ruleId: rule.id, kind, value, name: rule.name });
  }
  return blocked;
}

/** Removes one block rule. Future mail is delivered again. Mail already in Trash stays there until restored. */
export async function unblockSender(host: SiHost, ruleId: string): Promise<{ blocked: SiBlock[]; changeId: string }> {
  if (!isSiBlockId(ruleId)) throw new MailError("That is not a block", "invalid");
  const doc = await host.getRules();
  const before = doc.rules.find((rule) => rule.id === ruleId);
  if (!before) throw new MailError(`No block ${ruleId}`, "not_found");
  const next: RulesDocument = {
    ...doc,
    rules: doc.rules.filter((rule) => rule.id !== ruleId),
    updatedAt: host.now().toISOString(),
    updatedBy: "human",
  };
  await saveRules(host.blobs, host.keys, next);
  const change: SiChange = {
    id: newId("sic"),
    at: next.updatedAt,
    messages: [],
    rules: [{ id: ruleId, before, after: null }],
  };
  const ledger = await loadLedger(host);
  await saveLedger(host, { version: 1, changes: [...ledger.changes, change].slice(-LEDGER_CAP) });
  await host.audit("si.unblocked", "ok", { detail: `rule:${ruleId} change:${change.id}` });
  return { blocked: await listBlocked(host), changeId: change.id };
}

/** The system prompt for a reply. Tests pin that it refuses to send. */
export function siReplyPrompt(input: { tone?: string; instruction?: string; from: string; subject: string; sourceText: string; threadText: string }): {
  system: string;
  user: string;
} {
  const instruction = (input.instruction ?? "").trim().slice(0, 500);
  return {
    system: replySystem(toneOf(input.tone), instruction),
    user: replyUser({
      from: input.from,
      subject: input.subject,
      sourceText: input.sourceText.slice(0, 4000),
      threadText: input.threadText.slice(0, 4000),
    }),
  };
}
