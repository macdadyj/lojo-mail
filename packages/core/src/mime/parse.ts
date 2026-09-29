import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { newId, normalizeMessageId, sha256 } from "../ids.ts";
import type { Address } from "../types.ts";
import { htmlToText } from "./html.ts";

export interface ParsedAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  bytes: Uint8Array;
}

export interface ParsedInbound {
  rfcMessageId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo?: Address;
  subject: string;
  date: string;
  text: string;
  html: string;
  inReplyTo?: string;
  references: string[];
  listUnsubscribe?: string;
  listId?: string;
  precedence?: string;
  autoSubmitted?: string;
  attachments: ParsedAttachment[];
  pgpEncrypted: boolean;
}

function asAddressList(value: AddressObject | AddressObject[] | undefined): Address[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  const out: Address[] = [];
  for (const object of objects) {
    for (const entry of object.value) {
      if (!entry.address) continue;
      const address: Address = { email: entry.address };
      if (entry.name) address.name = entry.name;
      out.push(address);
    }
  }
  return out;
}

function headerString(parsed: ParsedMail, name: string): string | undefined {
  const value = parsed.headers.get(name);
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ");
  if (value && typeof value === "object" && "value" in value && typeof value.value === "string") return value.value;
  return undefined;
}

function referenceList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : value.split(/\s+/);
  return parts.map((part) => normalizeMessageId(part)).filter((part) => part.length > 0);
}

function looksLikePgp(parsed: ParsedInbound, contentType: string): boolean {
  if (/multipart\/encrypted|application\/pgp-encrypted|application\/pgp-signature/i.test(contentType)) return true;
  if (parsed.text.includes("-----BEGIN PGP MESSAGE-----")) return true;
  return parsed.attachments.some((item) => /pgp/i.test(item.contentType) || /pgp/i.test(item.filename));
}

export async function parseMime(raw: Buffer | string): Promise<ParsedInbound> {
  const buffer = typeof raw === "string" ? Buffer.from(raw) : raw;
  const parsed = await simpleParser(buffer);
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text = (parsed.text ?? "").trim() || htmlToText(html);
  const contentType = headerString(parsed, "content-type") ?? "";
  const references = referenceList(parsed.references as string | string[] | undefined);
  const inReplyToRaw = headerString(parsed, "in-reply-to");
  const fromList = asAddressList(parsed.from);
  const from = fromList[0] ?? { email: "unknown@invalid" };
  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map((item) => {
    const bytes = new Uint8Array(item.content);
    return {
      id: newId("att"),
      filename: item.filename ?? "attachment",
      contentType: item.contentType || "application/octet-stream",
      size: item.size ?? bytes.byteLength,
      bytes,
    };
  });
  const message: ParsedInbound = {
    rfcMessageId: parsed.messageId ? normalizeMessageId(parsed.messageId) : `generated.${sha256(buffer)}`,
    from,
    to: asAddressList(parsed.to),
    cc: asAddressList(parsed.cc),
    subject: parsed.subject?.trim() || "(no subject)",
    date: (parsed.date ?? new Date()).toISOString(),
    text,
    html,
    references,
    attachments,
    pgpEncrypted: false,
  };
  if (inReplyToRaw) message.inReplyTo = normalizeMessageId(inReplyToRaw.split(/\s+/)[0] ?? inReplyToRaw);
  const replyTo = asAddressList(parsed.replyTo)[0];
  if (replyTo) message.replyTo = replyTo;
  const listUnsubscribe = headerString(parsed, "list-unsubscribe");
  if (listUnsubscribe) message.listUnsubscribe = listUnsubscribe;
  const listId = headerString(parsed, "list-id");
  if (listId) message.listId = listId;
  const precedence = headerString(parsed, "precedence");
  if (precedence) message.precedence = precedence;
  const autoSubmitted = headerString(parsed, "auto-submitted");
  if (autoSubmitted) message.autoSubmitted = autoSubmitted;
  message.pgpEncrypted = looksLikePgp(message, contentType);
  return message;
}
