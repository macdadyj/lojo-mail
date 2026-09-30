import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { normalizeMessageId, sha256 } from "../ids.ts";
import type { Address, Verdicts } from "../types.ts";
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
  autoResponseSuppress?: string;
  /** The envelope sender SES records. `<>` marks a bounce or other automatic message. */
  returnPath?: string;
  attachments: ParsedAttachment[];
  pgpEncrypted: boolean;
  verdicts: Verdicts;
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
  if (/multipart\/encrypted|application\/pgp-encrypted/i.test(contentType)) return true;
  if (parsed.text.includes("-----BEGIN PGP MESSAGE-----")) return true;
  return parsed.attachments.some((item) => /application\/pgp-encrypted/i.test(item.contentType));
}

/** Header lines in order, unfolded, from the top of the raw message. */
export function rawHeaders(buffer: Buffer): Array<[string, string]> {
  const text = buffer.subarray(0, Math.min(buffer.length, 256 * 1024)).toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const block = end >= 0 ? text.slice(0, end) : text;
  const out: Array<[string, string]> = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      const last = out[out.length - 1];
      if (last) last[1] = `${last[1]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    out.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return out;
}

function authResult(value: string, method: string): string | undefined {
  return value.match(new RegExp(`\\b${method}=([a-z]+)`, "i"))?.[1]?.toLowerCase();
}

/**
 * SES prepends its verdicts, so the topmost occurrence is the one SES wrote.
 * Anything lower down could have been supplied by the sender.
 */
export function sesVerdicts(headers: Array<[string, string]>): Verdicts {
  const verdicts: Verdicts = {};
  const first = (name: string) => headers.find(([key]) => key === name)?.[1];
  const spam = first("x-ses-spam-verdict");
  if (spam) verdicts.spam = spam.trim().toUpperCase();
  const virus = first("x-ses-virus-verdict");
  if (virus) verdicts.virus = virus.trim().toUpperCase();
  const auth = headers.find(([key, value]) => key === "authentication-results" && /^amazonses\.com\s*;/i.test(value))?.[1];
  if (auth) {
    const spf = authResult(auth, "spf");
    const dkim = authResult(auth, "dkim");
    const dmarc = authResult(auth, "dmarc");
    if (spf) verdicts.spf = spf;
    if (dkim) verdicts.dkim = dkim;
    if (dmarc) verdicts.dmarc = dmarc;
  }
  return verdicts;
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
  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map((item, index) => {
    const bytes = new Uint8Array(item.content);
    return {
      id: `att${index + 1}`,
      filename: item.filename ?? "attachment",
      contentType: item.contentType || "application/octet-stream",
      size: item.size ?? bytes.byteLength,
      bytes,
    };
  });
  const headers = rawHeaders(buffer);
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
    verdicts: sesVerdicts(headers),
  };
  if (inReplyToRaw) message.inReplyTo = normalizeMessageId(inReplyToRaw.split(/\s+/)[0] ?? inReplyToRaw);
  const replyTo = asAddressList(parsed.replyTo)[0];
  if (replyTo) message.replyTo = replyTo;
  // mailparser folds every List-* header into one structured `list` value, so read the raw lines.
  const header = (name: string) => headers.find(([key]) => key === name)?.[1];
  const listUnsubscribe = header("list-unsubscribe");
  if (listUnsubscribe) message.listUnsubscribe = listUnsubscribe;
  const listId = header("list-id");
  if (listId) message.listId = listId;
  const precedence = headerString(parsed, "precedence");
  if (precedence) message.precedence = precedence;
  const autoSubmitted = headerString(parsed, "auto-submitted");
  if (autoSubmitted) message.autoSubmitted = autoSubmitted;
  const suppress = header("x-auto-response-suppress");
  if (suppress) message.autoResponseSuppress = suppress;
  const returnPath = header("return-path");
  if (returnPath !== undefined) message.returnPath = returnPath;
  message.pgpEncrypted = looksLikePgp(message, contentType);
  return message;
}
