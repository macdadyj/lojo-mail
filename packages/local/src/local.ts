import type { LlmClient, MessageView, Thread } from "@lojo/core";
import { callTool, UNTRUSTED_PREAMBLE, type ToolContext } from "@lojo/mcp/tools";

/** Tool results are `wrapUntrusted` JSON. The CLI reads them back to print compact lists. */
export function unwrap<T>(wrapped: string): T {
  const start = wrapped.indexOf("<untrusted-mail-content>\n");
  const end = wrapped.lastIndexOf("\n</untrusted-mail-content>");
  if (start < 0 || end < start) throw new Error("Unexpected tool result shape");
  return JSON.parse(wrapped.slice(start + "<untrusted-mail-content>\n".length, end)) as T;
}

export function formatList(messages: MessageView[]): string {
  if (messages.length === 0) return "(no messages)";
  return messages
    .map((message) => {
      const who = message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email;
      const flags = [message.unread ? "unread" : "", message.ai?.priority ?? "", message.locked ? "locked" : ""].filter(Boolean).join(",");
      return `${message.date.slice(0, 10)}  ${who}\n  ${message.subject}\n  thread ${message.threadId}  message ${message.id}${flags ? `  [${flags}]` : ""}`;
    })
    .join("\n");
}

interface ThreadRead {
  thread: Thread;
  messages: MessageView[];
}

const SUMMARY_SYSTEM = `Summarize this email thread for Jon in a short paragraph, then bullet the action items with any deadlines. Do not invent facts.
${UNTRUSTED_PREAMBLE}`;

const REPLY_SYSTEM = `Write Jon's reply to the last message in this email thread. Plain text, short, in Jon's voice, signed "Jon". No subject line.
Only answer what was asked. Do not promise money, credentials, or anything the thread does not support.
${UNTRUSTED_PREAMBLE}`;

function threadText(read: ThreadRead): string {
  return read.messages
    .map((message) => {
      const body = message.text ?? message.contextText ?? message.snippet;
      return `From ${message.from.email} at ${message.date}\nSubject: ${message.subject}\n${body}`;
    })
    .join("\n\n---\n\n");
}

/** Reads a thread with its server-readable text. Needs the body scope; the API refuses otherwise. */
export async function readForModel(ctx: ToolContext, threadId: string): Promise<ThreadRead> {
  return unwrap<ThreadRead>(await callTool("read_thread", { threadId, includeContext: true }, ctx));
}

/** Summarizes on the local model. The thread text never goes to a hosted provider. */
export async function summarizeLocally(ctx: ToolContext, llm: LlmClient, threadId: string, maxChars = 12_000): Promise<string> {
  const read = await readForModel(ctx, threadId);
  const text = threadText(read).slice(0, maxChars);
  const completion = await llm.complete({ system: SUMMARY_SYSTEM, user: `<untrusted-mail-content>\n${text}\n</untrusted-mail-content>`, maxTokens: 500 });
  return completion.text.trim();
}

/**
 * Writes a reply on the local model and stores it as a draft through the API
 * (write scope). `submit` puts it in Jon's approval queue. Nothing here can
 * send: only Jon's approval in the web app mints the token that sends.
 */
export async function draftLocally(
  ctx: ToolContext,
  llm: LlmClient,
  threadId: string,
  opts: { submit?: boolean; instruction?: string; self?: string; maxChars?: number } = {},
): Promise<{ draftId: string; status: string; text: string }> {
  const read = await readForModel(ctx, threadId);
  const self = (opts.self ?? "").toLowerCase();
  const last = [...read.messages].reverse().find((message) => message.from.email.toLowerCase() !== self);
  if (!last) throw new Error("No message from someone else to reply to in this thread");
  const user = [
    `<untrusted-mail-content>\n${threadText(read).slice(0, opts.maxChars ?? 12_000)}\n</untrusted-mail-content>`,
    opts.instruction ? `Jon's instruction for this reply (trusted): ${opts.instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const completion = await llm.complete({ system: REPLY_SYSTEM, user, maxTokens: 400 });
  const text = completion.text.trim();
  if (!text) throw new Error("The local model returned an empty reply");
  const subject = /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`;
  const created = unwrap<{ draft: { id: string; status: string } }>(
    await callTool("create_draft", { to: [last.from.email], subject, text, threadId }, ctx),
  );
  if (!opts.submit) return { draftId: created.draft.id, status: created.draft.status, text };
  const submitted = unwrap<{ draft: { id: string; status: string } }>(await callTool("submit_for_approval", { draftId: created.draft.id }, ctx));
  return { draftId: submitted.draft.id, status: submitted.draft.status, text };
}
