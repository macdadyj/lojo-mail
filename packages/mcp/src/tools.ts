import { MailError, type Folder } from "@lojo/core";
import { z } from "zod";
import { asScope, hasScope, type Scope } from "./scopes.ts";

export interface MailClient {
  search(query: string, mode?: "keyword" | "semantic"): Promise<unknown>;
  readThread(threadId: string): Promise<unknown>;
  triage(limit?: number): Promise<unknown>;
  listInbox(limit?: number): Promise<unknown>;
  summarizeThread(threadId: string): Promise<string>;
  draftReply(messageId: string): Promise<unknown>;
  createDraft(input: { to: string[]; cc?: string[]; subject: string; text: string; threadId?: string }): Promise<unknown>;
  approveAndSend(draftId: string): Promise<{ messageId: string }>;
  setLabels(messageId: string, labels: string[]): Promise<unknown>;
  archive(messageId: string): Promise<unknown>;
  move(messageId: string, folder: Folder): Promise<unknown>;
  actionItems(): Promise<unknown>;
  exportAll(): Promise<string>;
}

export interface ToolContext {
  mailbox: MailClient;
  scopes: readonly Scope[];
}

const searchSchema = z.object({
  query: z.string(),
  mode: z.enum(["keyword", "semantic"]).optional(),
});
const threadSchema = z.object({ threadId: z.string() });
const inboxSchema = z.object({ limit: z.number().int().positive().max(100).optional() });
const messageSchema = z.object({ messageId: z.string() });
const draftSchema = z.object({
  to: z.array(z.string().email()),
  cc: z.array(z.string().email()).optional(),
  subject: z.string(),
  text: z.string(),
  threadId: z.string().optional(),
});
const labelSchema = z.object({ messageId: z.string(), labels: z.array(z.string()) });
const moveSchema = z.object({
  messageId: z.string(),
  folder: z.enum(["inbox", "sent", "drafts", "spam", "trash", "archive"]),
});

export const tools = [
  {
    name: "search_mail",
    scope: "read",
    description: "Search mail by keyword, or semantically when embeddings exist.",
    schema: searchSchema,
    run: (args: z.infer<typeof searchSchema>, ctx: ToolContext) => ctx.mailbox.search(args.query, args.mode ?? "keyword"),
  },
  {
    name: "read_thread",
    scope: "read",
    description: "Read one thread, including the AI summary when the mailbox is unlocked.",
    schema: threadSchema,
    run: (args: z.infer<typeof threadSchema>, ctx: ToolContext) => ctx.mailbox.readThread(args.threadId),
  },
  {
    name: "list_inbox",
    scope: "read",
    description: "List the inbox. Pass triage true for the priority view.",
    schema: inboxSchema.extend({ triage: z.boolean().optional() }),
    run: async (args: { limit?: number; triage?: boolean }, ctx: ToolContext) =>
      args.triage ? ctx.mailbox.triage(args.limit ?? 50) : ctx.mailbox.listInbox(args.limit ?? 50),
  },
  {
    name: "summarize_thread",
    scope: "read",
    description: "Summarize a thread with the configured model. Does not send mail.",
    schema: threadSchema,
    run: async (args: z.infer<typeof threadSchema>, ctx: ToolContext) => ({
      summary: await ctx.mailbox.summarizeThread(args.threadId),
    }),
  },
  {
    name: "draft_reply",
    scope: "write",
    description: "Create a suggested reply draft. Does not send it.",
    schema: messageSchema,
    run: (args: z.infer<typeof messageSchema>, ctx: ToolContext) => ctx.mailbox.draftReply(args.messageId),
  },
  {
    name: "create_draft",
    scope: "write",
    description: "Create a draft. Does not send it.",
    schema: draftSchema,
    run: (args: z.infer<typeof draftSchema>, ctx: ToolContext) => ctx.mailbox.createDraft(args),
  },
  {
    name: "approve_and_send",
    scope: "send",
    description: "Send an existing draft. Requires the send scope. The model cannot call this on its own.",
    schema: z.object({ draftId: z.string() }),
    run: (args: { draftId: string }, ctx: ToolContext) => ctx.mailbox.approveAndSend(args.draftId),
  },
  {
    name: "label_message",
    scope: "write",
    description: "Replace labels on a message.",
    schema: labelSchema,
    run: (args: z.infer<typeof labelSchema>, ctx: ToolContext) => ctx.mailbox.setLabels(args.messageId, args.labels),
  },
  {
    name: "archive_message",
    scope: "write",
    description: "Move a message to the archive.",
    schema: messageSchema,
    run: (args: z.infer<typeof messageSchema>, ctx: ToolContext) => ctx.mailbox.archive(args.messageId),
  },
  {
    name: "move_message",
    scope: "write",
    description: "Move a message to a folder.",
    schema: moveSchema,
    run: (args: z.infer<typeof moveSchema>, ctx: ToolContext) => ctx.mailbox.move(args.messageId, args.folder),
  },
  {
    name: "get_action_items",
    scope: "read",
    description: "List action items extracted from unlocked inbox mail.",
    schema: z.object({}),
    run: (_args: Record<string, never>, ctx: ToolContext) => ctx.mailbox.actionItems(),
  },
  {
    name: "export_mailbox",
    scope: "read",
    description: "Export the mailbox as JSON. Bodies are included only when the mailbox is unlocked.",
    schema: z.object({}),
    run: async (_args: Record<string, never>, ctx: ToolContext) => JSON.parse(await ctx.mailbox.exportAll()) as unknown,
  },
];

export type ToolName = (typeof tools)[number]["name"];

export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<string> {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new MailError(`Unknown tool ${name}`, "invalid");
  const scope = asScope(tool.scope);
  if (!hasScope(ctx.scopes, scope)) throw new MailError(`Missing ${scope} scope for ${name}`, "forbidden");
  const parsed = tool.schema.parse(args ?? {}) as never;
  const result = await tool.run(parsed, ctx);
  return JSON.stringify(result, null, 2);
}
