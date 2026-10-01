import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, sep } from "node:path";
import { FOLDERS, LOJO_TEST_RECIPIENT, type BotScope, type MessageView } from "@lojo/core";
import { z } from "zod";
import { id } from "./api.ts";
import { BotConfigError, type BotPaths } from "./config.ts";
import { bodyOf, type OpContext } from "./context.ts";
import { runDigest } from "./digest.ts";

export interface OpAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const READ_ONLY: OpAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Reading a thread clears its unread flags; the digest moves its cursor. */
const MARKS_READ: OpAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CHANGES: OpAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SOFT_DELETES: OpAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const SENDS: OpAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

interface OpDef<S extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  scopes: BotScope[];
  annotations: OpAnnotations;
  schema: S;
  run: (args: z.infer<S>, ctx: OpContext) => Promise<unknown>;
}

export type Op = OpDef<z.ZodObject<z.ZodRawShape>>;

function op<S extends z.ZodObject<z.ZodRawShape>>(def: OpDef<S>): Op {
  return def as unknown as Op;
}

const AGENT_FOLDERS = ["inbox", "archive", "spam"] as const;
const MAX_ATTACH_BYTES = 4_000_000;
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".zip": "application/zip",
  ".ics": "text/calendar",
};

async function messageWithBody(ctx: OpContext, messageId: string, html: boolean) {
  const context = ctx.scopes.includes("body") ? "?context=1" : "";
  const view = await ctx.api.get<MessageView>(`/v1/messages/${id(messageId)}${context}`);
  const { contextText: _context, ...rest } = view;
  return { message: rest, body: await bodyOf(ctx, view, html) };
}

function self(ctx: OpContext, email: string): boolean {
  return email.toLowerCase() === ctx.mailbox.toLowerCase();
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/** Only files under the attach directory, by real path, so a prompt cannot point attach_file at ~/.ssh or the bot's own key. */
export function readAttachment(paths: BotPaths, path: string): { bytes: Buffer; filename: string } {
  let root: string;
  let real: string;
  try {
    root = realpathSync(paths.attachDir);
    real = realpathSync(path.startsWith(sep) ? path : `${paths.attachDir}${sep}${path}`);
  } catch {
    throw new BotConfigError(`attach_file reads only files under ${paths.attachDir}, and ${path} is not there`);
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) throw new BotConfigError(`attach_file reads only files under ${paths.attachDir}`);
  const info = statSync(real);
  if (!info.isFile()) throw new BotConfigError(`${path} is not a file`);
  if (info.size > MAX_ATTACH_BYTES) throw new BotConfigError(`${path} is over ${MAX_ATTACH_BYTES} bytes`);
  return { bytes: readFileSync(real), filename: basename(real) };
}

const messageId = z.object({ messageId: z.string().min(1) });
const draftId = z.object({ draftId: z.string().min(1) });
const emails = z.array(z.string().email());

export const ops: Op[] = [
  op({
    name: "health",
    description: "API health, who this credential is, its scopes, and whether this machine holds the bot key the API seals copies to.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({}),
    run: async (_args, ctx) => {
      const api = await ctx.api.get("/v1/health");
      const me = await ctx.api.get<{ bot: string; scopes: string[]; envelopeKeyId: string | null }>("/v1/bot/whoami");
      return {
        api,
        bot: me.bot,
        scopes: me.scopes,
        envelopeKey: { registered: me.envelopeKeyId, loaded: ctx.key?.keyId ?? null, matches: Boolean(me.envelopeKeyId && me.envelopeKeyId === ctx.key?.keyId) },
      };
    },
  }),
  op({
    name: "settings",
    description: "Mailbox settings: address, model provider, budget, attachment limits. Read only.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({}),
    run: (_args, ctx) => ctx.api.get("/v1/settings"),
  }),
  op({
    name: "audit_log",
    description: "Recent audit events (the last seven days, newest first), including this bot's own requests as actor bot:<name>.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({ limit: z.number().int().positive().max(200).optional(), mine: z.boolean().optional() }),
    run: async (args, ctx) => {
      const { events } = await ctx.api.get<{ events: Array<{ actor?: string }> }>("/v1/audit");
      const me = (await ctx.api.get<{ bot: string }>("/v1/bot/whoami")).bot;
      return (args.mine ? events.filter((event) => event.actor === me) : events).slice(0, args.limit ?? 50);
    },
  }),
  op({
    name: "list_inbox",
    description: "List the inbox, newest first (metadata, snippet and AI labels; no bodies). triage true gives the priority view.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({ limit: z.number().int().positive().max(200).optional(), unreadOnly: z.boolean().optional(), triage: z.boolean().optional() }),
    run: async (args, ctx) => {
      const path = args.triage ? "/v1/triage" : `/v1/folders/inbox/messages?limit=${args.limit ?? 50}`;
      const { messages } = await ctx.api.get<{ messages: MessageView[] }>(path);
      return messages.filter((message) => !args.unreadOnly || message.unread).slice(0, args.limit ?? 50);
    },
  }),
  op({
    name: "list_folder",
    description: "List one folder (inbox, sent, drafts, spam, trash, archive), newest first.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({ folder: z.enum(FOLDERS), limit: z.number().int().positive().max(500).optional() }),
    run: async (args, ctx) => (await ctx.api.get<{ messages: unknown }>(`/v1/folders/${args.folder}/messages?limit=${args.limit ?? 50}`)).messages,
  }),
  op({
    name: "read_message",
    description:
      "Read one message with its body. The body is opened on this machine with the bot key; bodySource says where it came from (bot-key, ai-context, or none). Does not mark it read.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: messageId.extend({ html: z.boolean().optional() }),
    run: (args, ctx) => messageWithBody(ctx, args.messageId, args.html ?? false),
  }),
  op({
    name: "read_thread",
    description: "Read a whole thread with bodies, oldest first. Marks the thread read.",
    scopes: ["read"],
    annotations: MARKS_READ,
    schema: z.object({ threadId: z.string().min(1) }),
    run: async (args, ctx) => {
      const context = ctx.scopes.includes("body") ? "?context=1" : "";
      const thread = await ctx.api.get<{ thread: unknown; messages: MessageView[] }>(`/v1/threads/${id(args.threadId)}${context}`);
      const messages = [];
      for (const view of thread.messages) {
        const { contextText: _context, ...rest } = view;
        messages.push({ message: rest, body: await bodyOf(ctx, view) });
      }
      return { thread: thread.thread, messages };
    },
  }),
  op({
    name: "search",
    description: "Search mail by keyword (subject, sender, snippet, labels, and AI-context text). Semantic mode needs embeddings on the server.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({ query: z.string().min(1), mode: z.enum(["keyword", "semantic"]).optional() }),
    run: async (args, ctx) =>
      (await ctx.api.post<{ messages: unknown }>("/v1/search", { query: args.query, mode: args.mode ?? "keyword", context: ctx.scopes.includes("body") })).messages,
  }),
  op({
    name: "digest",
    description:
      "Short, summary-ready JSON of mail that arrived since the last digest (a cursor kept on this machine), with excerpts. peek true leaves the cursor where it is.",
    scopes: ["read"],
    annotations: MARKS_READ,
    schema: z.object({ peek: z.boolean().optional(), limit: z.number().int().positive().max(100).optional(), excerpts: z.boolean().optional(), sinceHours: z.number().positive().max(720).optional() }),
    run: (args, ctx) => runDigest(ctx, args),
  }),
  op({
    name: "mark_read",
    description: "Mark one message read (read true) or unread (read false).",
    scopes: ["write"],
    annotations: CHANGES,
    schema: messageId.extend({ read: z.boolean() }),
    run: (args, ctx) => ctx.api.post(`/v1/messages/${id(args.messageId)}/flags`, { unread: !args.read }),
  }),
  op({
    name: "flag",
    description: "Flag or unflag a message (the flagged label, Thunderbird's star).",
    scopes: ["write"],
    annotations: CHANGES,
    schema: messageId.extend({ flagged: z.boolean() }),
    run: async (args, ctx) => {
      const view = await ctx.api.get<MessageView>(`/v1/messages/${id(args.messageId)}`);
      const labels = view.labels.filter((label) => label !== "flagged");
      return ctx.api.post(`/v1/messages/${id(args.messageId)}/labels`, { labels: args.flagged ? [...labels, "flagged"] : labels });
    },
  }),
  op({
    name: "set_labels",
    description: "Replace a message's labels.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: messageId.extend({ labels: z.array(z.string()) }),
    run: (args, ctx) => ctx.api.post(`/v1/messages/${id(args.messageId)}/labels`, { labels: args.labels }),
  }),
  op({
    name: "list_labels",
    description: "Every label in use.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({}),
    run: async (_args, ctx) => (await ctx.api.get<{ labels: unknown }>("/v1/labels")).labels,
  }),
  op({
    name: "move_message",
    description: "Move a message to inbox, archive or spam. To delete, use trash_message.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: messageId.extend({ folder: z.enum(AGENT_FOLDERS) }),
    run: (args, ctx) => ctx.api.post(`/v1/messages/${id(args.messageId)}/move`, { folder: args.folder }),
  }),
  op({
    name: "trash_message",
    description: "Move a message to Trash. Soft delete: restorable until the retention window ends, capped per bot per day. Never a hard delete.",
    scopes: ["write", "trash"],
    annotations: SOFT_DELETES,
    schema: messageId,
    run: (args, ctx) => ctx.api.post(`/v1/messages/${id(args.messageId)}/move`, { folder: "trash" }),
  }),
  op({
    name: "restore_message",
    description: "Take a message out of Trash, back to the inbox.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: messageId,
    run: (args, ctx) => ctx.api.post(`/v1/messages/${id(args.messageId)}/restore`),
  }),
  op({
    name: "list_drafts",
    description: "List drafts with status (suggested, edited, pending_approval, sent, discarded) and origin. includeText adds each draft's text.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({ includeText: z.boolean().optional() }),
    run: async (args, ctx) => (await ctx.api.get<{ drafts: unknown }>(`/v1/drafts${args.includeText && ctx.scopes.includes("body") ? "?text=1" : ""}`)).drafts,
  }),
  op({
    name: "get_draft",
    description: "One draft with its text and files.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: draftId,
    run: (args, ctx) => ctx.api.get(`/v1/drafts/${id(args.draftId)}${ctx.scopes.includes("body") ? "?text=1" : ""}`),
  }),
  op({
    name: "create_draft",
    description: "Create a draft to existing contacts or thread participants. It is not sent: Jon reviews and sends it himself.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: z.object({ to: emails.min(1), cc: emails.optional(), subject: z.string(), text: z.string(), threadId: z.string().optional(), inReplyTo: z.string().optional() }),
    run: (args, ctx) => ctx.api.post("/v1/drafts", args),
  }),
  op({
    name: "draft_reply",
    description:
      "Draft a reply to a message with the text you give, threaded correctly, to its sender (replyAll adds the other recipients). Not sent: it lands in Jon's Drafts and approval queue.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: messageId.extend({ text: z.string().min(1), replyAll: z.boolean().optional() }),
    run: async (args, ctx) => {
      const view = await ctx.api.get<MessageView>(`/v1/messages/${id(args.messageId)}`);
      const to = view.origin === "sent" ? view.to.map((item) => item.email) : [view.from.email];
      const others = args.replyAll ? [...view.to, ...view.cc].map((item) => item.email).filter((email) => !self(ctx, email) && !to.includes(email)) : [];
      return ctx.api.post("/v1/drafts", { to, cc: others, subject: replySubject(view.subject), text: args.text, inReplyTo: view.rfcMessageId });
    },
  }),
  op({
    name: "update_draft",
    description: "Edit a draft's text, subject or recipients. Any edit clears a pending approval.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: draftId.extend({ text: z.string().optional(), subject: z.string().optional(), to: emails.optional(), cc: emails.optional() }),
    run: ({ draftId: draft, ...patch }, ctx) => ctx.api.post(`/v1/drafts/${id(draft)}`, patch),
  }),
  op({
    name: "attach_file",
    description: "Attach a file to a draft: a path under the bot's attach directory, or base64 content with a filename. Jon's approval names every file.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: draftId.extend({ path: z.string().optional(), contentBase64: z.string().optional(), filename: z.string().optional(), contentType: z.string().optional() }),
    run: async (args, ctx) => {
      if (Boolean(args.path) === Boolean(args.contentBase64)) throw new BotConfigError("Give exactly one of path and contentBase64");
      const file = args.path ? readAttachment(ctx.paths, args.path) : { bytes: Buffer.from(args.contentBase64 ?? "", "base64"), filename: args.filename ?? "attachment" };
      if (file.bytes.byteLength > MAX_ATTACH_BYTES) throw new BotConfigError(`Files are at most ${MAX_ATTACH_BYTES} bytes`);
      const filename = args.filename ?? file.filename;
      return ctx.api.post(`/v1/drafts/${id(args.draftId)}/attachments`, {
        filename,
        contentType: args.contentType ?? CONTENT_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream",
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        data: file.bytes.toString("base64"),
      });
    },
  }),
  op({
    name: "remove_attachment",
    description: "Remove one file from a draft.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: draftId.extend({ attachmentId: z.string().min(1) }),
    run: (args, ctx) => ctx.api.post(`/v1/drafts/${id(args.draftId)}/attachments/${id(args.attachmentId)}/remove`),
  }),
  op({
    name: "discard_draft",
    description: "Discard a draft. It is never sent.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: draftId,
    run: (args, ctx) => ctx.api.post(`/v1/drafts/${id(args.draftId)}/discard`),
  }),
  op({
    name: "submit_for_approval",
    description: "Ask Jon to approve a draft: it goes to his approval queue. Only Jon can approve and send.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: draftId,
    run: (args, ctx) => ctx.api.post(`/v1/drafts/${id(args.draftId)}/submit`),
  }),
  op({
    name: "list_rules",
    description: "Jon's mail rules and the bot's own, with switches. createdBy says who wrote each rule.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: z.object({}),
    run: (_args, ctx) => ctx.api.get("/v1/rules"),
  }),
  op({
    name: "upsert_rule",
    description:
      "Add or replace one bot rule by id: match (from, to, subjectContains, listId, categories, priorities, aiLabels, bulk, hasAttachment) and actions (label, move to inbox/archive/spam, markRead, reply as a draft). Never auto-send, never trash, never one of Jon's rules.",
    scopes: ["rules"],
    annotations: CHANGES,
    schema: z.object({ rule: z.object({ id: z.string() }).passthrough() }),
    run: (args, ctx) => ctx.api.put(`/v1/rules/bot-rules/${id(args.rule.id)}`, args.rule),
  }),
  op({
    name: "delete_rule",
    description: "Delete one bot rule. Jon's rules cannot be deleted by a bot; disable_rule them instead.",
    scopes: ["rules"],
    annotations: CHANGES,
    schema: z.object({ ruleId: z.string().min(1) }),
    run: (args, ctx) => ctx.api.post(`/v1/rules/bot-rules/${id(args.ruleId)}/delete`),
  }),
  op({
    name: "disable_rule",
    description: "Turn any rule off (Jon's too). Only Jon can turn his back on.",
    scopes: ["write"],
    annotations: CHANGES,
    schema: z.object({ ruleId: z.string().min(1) }),
    run: (args, ctx) => ctx.api.post(`/v1/rules/${id(args.ruleId)}/disable`),
  }),
  op({
    name: "test_rules",
    description: "Dry run: what the current rules would do to one message. Changes nothing.",
    scopes: ["read"],
    annotations: READ_ONLY,
    schema: messageId,
    run: (args, ctx) => ctx.api.post("/v1/rules/test", { messageId: args.messageId }),
  }),
  op({
    name: "send_test_to_lojo_test",
    description: `Send one plain-text test message to ${LOJO_TEST_RECIPIENT} and nobody else. Only when Jon explicitly asks for a test send. Rate limited; stopped by the send kill switch.`,
    scopes: ["test-send"],
    annotations: SENDS,
    schema: z.object({ subject: z.string().min(1).max(200), text: z.string().min(1).max(5000) }),
    run: (args, ctx) => ctx.api.post("/v1/bot/test-send", args),
  }),
];

export function allowedOps(scopes: readonly string[]): Op[] {
  return ops.filter((item) => item.scopes.every((scope) => scopes.includes(scope)));
}

export async function runOp(name: string, args: unknown, ctx: OpContext): Promise<unknown> {
  const found = ops.find((item) => item.name === name);
  if (!found) throw new BotConfigError(`Unknown operation ${name}. Run lojo-bot ops for the list.`);
  const missing = found.scopes.filter((scope) => !ctx.scopes.includes(scope));
  if (missing.length > 0) throw new BotConfigError(`${name} needs the ${missing.join(", ")} scope, which this bot credential does not have`);
  return found.run(found.schema.parse(args ?? {}), ctx);
}
