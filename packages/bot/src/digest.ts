import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UNTRUSTED_PREAMBLE } from "@lojo/mcp/tools";
import type { MessageView } from "@lojo/core";
import { writePrivateFile } from "./config.ts";
import { bodyOf, type OpContext } from "./context.ts";

/**
 * The cursor is the set of message ids already reported, not a date: the Date
 * header is whatever the sender wrote, so a backdated message would slip past
 * a date cursor. The first run reports only mail from the last `sinceHours`.
 */
interface DigestState {
  version: 1;
  seen: string[];
  lastRunAt: string;
}

export interface DigestOptions {
  peek?: boolean | undefined;
  limit?: number | undefined;
  excerpts?: boolean | undefined;
  sinceHours?: number | undefined;
}

const SCAN = { inbox: 200, spam: 50 } as const;
const MAX_SEEN = 5000;
const EXCERPT_CHARS = 280;

export function digestStatePath(stateDir: string): string {
  return join(stateDir, "digest.json");
}

function loadState(path: string): DigestState | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DigestState>;
  if (parsed.version !== 1 || !Array.isArray(parsed.seen) || typeof parsed.lastRunAt !== "string") return null;
  return { version: 1, seen: parsed.seen.filter((item): item is string => typeof item === "string"), lastRunAt: parsed.lastRunAt };
}

function sender(view: MessageView): string {
  return view.from.name ? `${view.from.name} <${view.from.email}>` : view.from.email;
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

/** What sent, or would have sent, on Jon's behalf: unsubscribes, shadow and live rule replies, chat-approved and test sends. */
const AUTOMATION_ACTIONS = new Set([
  "rule.unsubscribe",
  "rule.shadow",
  "rule.autosend",
  "send.chat_approved",
  "send.chat_refused",
  "bot.send_new",
  "bot.send_new_refused",
  "bot.send_grant_expired",
  "bot.test_send",
]);
const AUDIT_SCAN = 500;

interface AuditRow {
  at: string;
  action: string;
  outcome: string;
  messageId?: string;
  detail?: string;
  actor?: string;
}

async function automationSince(ctx: OpContext, since: string) {
  const { events } = await ctx.api.get<{ events: AuditRow[] }>(`/v1/audit?limit=${AUDIT_SCAN}`);
  const rows = events.filter((event) => AUTOMATION_ACTIONS.has(event.action) && event.at > since);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[`${row.action}:${row.outcome}`] = (counts[`${row.action}:${row.outcome}`] ?? 0) + 1;
  return {
    counts,
    events: rows.slice(0, 50).map((row) => ({
      at: row.at,
      action: row.action,
      outcome: row.outcome,
      ...(row.messageId ? { messageId: row.messageId } : {}),
      ...(row.actor ? { actor: row.actor } : {}),
      ...(row.detail ? { detail: row.detail } : {}),
    })),
    truncated: rows.length > 50 || events.length >= AUDIT_SCAN,
  };
}

export async function runDigest(ctx: OpContext, opts: DigestOptions = {}) {
  const now = ctx.now();
  const path = digestStatePath(ctx.paths.stateDir);
  const state = loadState(path);
  const seen = new Set(state?.seen ?? []);
  const cutoff = now.getTime() - (opts.sinceHours ?? 24) * 3_600_000;
  const listed: MessageView[] = [];
  for (const [folder, limit] of Object.entries(SCAN)) {
    const { messages } = await ctx.api.get<{ messages: MessageView[] }>(`/v1/folders/${folder}/messages?limit=${limit}`);
    listed.push(...messages);
  }
  const baseline = state ? [] : listed.filter((view) => Date.parse(view.date) < cutoff).map((view) => view.id);
  for (const id of baseline) seen.add(id);
  const fresh = listed.filter((view) => !seen.has(view.id)).sort((a, b) => (a.date < b.date ? 1 : -1));
  const limit = opts.limit ?? 25;
  const reported = fresh.slice(0, limit);

  const messages = [];
  for (const view of reported) {
    const item: Record<string, unknown> = {
      id: view.id,
      threadId: view.threadId,
      folder: view.folder,
      from: sender(view),
      subject: view.subject,
      date: view.date,
      unread: view.unread,
      labels: view.labels,
      attachments: view.attachments.length,
      ...(view.ai ? { priority: view.ai.priority, category: view.ai.category, phishingScore: view.ai.phishingScore } : {}),
      ...(view.snippet ? { snippet: view.snippet } : {}),
    };
    if (opts.excerpts !== false) {
      const body = await bodyOf(ctx, view);
      if (body.text) item.excerpt = excerptOf(body.text);
    }
    messages.push(item);
  }

  const { drafts } = await ctx.api.get<{ drafts: Array<{ draft: { status: string } }> }>("/v1/drafts");
  const since = state?.lastRunAt ?? new Date(cutoff).toISOString();
  const automation = await automationSince(ctx, since);
  const result = {
    note: UNTRUSTED_PREAMBLE,
    generatedAt: now.toISOString(),
    since,
    peek: opts.peek === true,
    counts: {
      new: fresh.length,
      reported: reported.length,
      newInInbox: fresh.filter((view) => view.folder === "inbox").length,
      newInSpam: fresh.filter((view) => view.folder === "spam").length,
      unreadInInbox: listed.filter((view) => view.folder === "inbox" && view.unread).length,
      urgent: fresh.filter((view) => view.ai?.priority === "now" || view.ai?.priority === "today").length,
      draftsAwaitingJon: drafts.filter((item) => item.draft.status === "pending_approval").length,
    },
    truncated: fresh.length > reported.length,
    messages,
    automation,
  };

  if (!opts.peek) {
    const next = [...reported.map((view) => view.id), ...baseline, ...(state?.seen ?? [])];
    const unique = [...new Set(next)].slice(0, MAX_SEEN);
    writePrivateFile(path, `${JSON.stringify({ version: 1, seen: unique, lastRunAt: now.toISOString() } satisfies DigestState)}\n`, { force: true });
  }
  return result;
}
