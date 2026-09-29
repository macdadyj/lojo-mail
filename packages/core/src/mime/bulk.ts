import type { ParsedInbound } from "./parse.ts";

export function isBulk(message: Pick<ParsedInbound, "precedence" | "listId" | "listUnsubscribe" | "autoSubmitted">): boolean {
  if (message.precedence && /^(bulk|list|junk)$/i.test(message.precedence.trim())) return true;
  if (message.listId && message.listUnsubscribe) return true;
  if (message.autoSubmitted && !/^no$/i.test(message.autoSubmitted.trim())) return true;
  return false;
}
