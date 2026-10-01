import type { EnvelopeBlob, MessageView } from "@lojo/core";
import { ApiError, id, type BotApi } from "./api.ts";
import type { BotPaths } from "./config.ts";
import { openBotCopy, type LoadedBotKey } from "./keys.ts";

export interface OpContext {
  api: BotApi;
  /** What the API says this credential holds (GET /v1/bot/whoami). */
  scopes: readonly string[];
  key: LoadedBotKey | null;
  paths: BotPaths;
  mailbox: string;
  now: () => Date;
}

export type BodySource = "bot-key" | "ai-context" | "none";

/** Bodies come from the bot's own sealed copy when possible, then the server's short-lived AI-context text. */
export async function bodyOf(ctx: OpContext, view: MessageView, html = false): Promise<{ source: BodySource; text?: string; html?: string; note?: string }> {
  if (!ctx.scopes.includes("body")) return { source: "none", note: "This credential has no body scope" };
  if (ctx.key) {
    try {
      const copy = await ctx.api.get<{ keyId: string; envelope: EnvelopeBlob }>(`/v1/messages/${id(view.id)}/bot-copy`);
      const opened = await openBotCopy(ctx.key, view.id, copy.keyId, copy.envelope);
      return { source: "bot-key", text: opened.text, ...(html ? { html: opened.html } : {}) };
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  if (typeof view.contextText === "string") return { source: "ai-context", text: view.contextText };
  return { source: "none", note: ctx.key ? "No bot copy for this message (older than the bot key; Jon can backfill)" : "No bot envelope key loaded on this machine" };
}

