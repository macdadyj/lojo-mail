import { createHash } from "node:crypto";
import { encodeHeaderText, formatAddress, htmlToText, type Address, type MessageView } from "@lojo/core";

export type Params = Array<[string, string]>;

export interface MimeNode {
  /** The part's header block, including the blank line that ends it. */
  header: Buffer;
  body: Buffer;
  type: string;
  subtype: string;
  params: Params;
  encoding: string | null;
  disposition: { type: string; params: Params } | null;
  children: MimeNode[];
  lines: number;
}

export interface BuiltMessage {
  raw: Buffer;
  root: MimeNode;
  /** Decrypted text for SEARCH TEXT/BODY. Lives only in the in-memory cache. */
  searchText: string;
}

export interface BodyContent {
  text: string;
  html: string;
}

export interface AttachmentContent {
  filename: string;
  contentType: string;
  bytes: Uint8Array | null;
}

const CRLF = "\r\n";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function wrapBase64(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join(CRLF);
}

function countLines(body: Buffer): number {
  if (body.length === 0) return 0;
  let lines = 0;
  for (const byte of body) if (byte === 0x0a) lines += 1;
  return body[body.length - 1] === 0x0a ? lines : lines + 1;
}

function clean(value: string): string {
  // eslint-disable-next-line no-control-regex -- header values must not carry control characters
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function paramValue(value: string): string {
  const cleaned = clean(value);
  if (/^[\x20-\x7e]*$/.test(cleaned)) return cleaned;
  return encodeHeaderText(cleaned).replace(/\r\n /g, " ");
}

function formatParams(params: Params): string {
  return params.map(([key, value]) => `; ${key}="${value.replace(/["\\]/g, "\\$&")}"`).join("");
}

function safeContentType(value: string): [string, string] {
  const match = /^([a-z0-9!#$&^_.+-]+)\/([a-z0-9!#$&^_.+-]+)$/i.exec(value.split(";")[0]?.trim() ?? "");
  if (!match?.[1] || !match[2]) return ["application", "octet-stream"];
  const type = match[1].toLowerCase();
  if (type === "multipart" || type === "message") return ["application", "octet-stream"];
  return [type, match[2].toLowerCase()];
}

function leaf(type: string, subtype: string, params: Params, bytes: Uint8Array, disposition: MimeNode["disposition"]): MimeNode {
  const lines = [`Content-Type: ${type}/${subtype}${formatParams(params)}`];
  if (disposition) lines.push(`Content-Disposition: ${disposition.type}${formatParams(disposition.params)}`);
  lines.push("Content-Transfer-Encoding: base64");
  const body = Buffer.from(wrapBase64(bytes), "latin1");
  return {
    header: Buffer.from(`${lines.join(CRLF)}${CRLF}${CRLF}`, "latin1"),
    body,
    type,
    subtype,
    params,
    encoding: "base64",
    disposition,
    children: [],
    lines: countLines(body),
  };
}

function multipart(subtype: string, boundary: string, children: MimeNode[]): MimeNode {
  const chunks: Buffer[] = [];
  for (const child of children) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`, "latin1"), child.header, child.body, Buffer.from(CRLF, "latin1"));
  }
  chunks.push(Buffer.from(`--${boundary}--`, "latin1"));
  const params: Params = [["boundary", boundary]];
  return {
    header: Buffer.from(`Content-Type: multipart/${subtype}${formatParams(params)}${CRLF}${CRLF}`, "latin1"),
    body: Buffer.concat(chunks),
    type: "multipart",
    subtype,
    params,
    encoding: null,
    disposition: null,
    children,
    lines: 0,
  };
}

function addressList(addresses: Address[]): string | null {
  const out: string[] = [];
  for (const address of addresses) {
    try {
      out.push(formatAddress(address));
    } catch {
      continue;
    }
  }
  return out.length > 0 ? out.join(`,${CRLF} `) : null;
}

function messageId(value: string): string {
  return `<${clean(value).replace(/[<>\s]/g, "")}>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function messageDate(view: Pick<MessageView, "date">): Date {
  const date = new Date(view.date);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export function rfc5322Date(date: Date): string {
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${time} +0000`;
}

/** IMAP date-time, e.g. `16-Sep-2026 15:04:00 +0000`. */
export function internalDate(date: Date): string {
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${pad(date.getUTCDate())}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ${time} +0000`;
}

/**
 * Only headers that never change for a message: IMAP messages are immutable, and
 * RFC822.SIZE is cached. Labels and folder change, so they travel as flags.
 */
function topHeaders(view: MessageView, extra: readonly string[]): string[] {
  const lines = [`X-Lojo-Id: ${clean(view.id)}`, ...extra.map(clean), `Date: ${rfc5322Date(messageDate(view))}`];
  const from = addressList([view.from]);
  if (from) lines.push(`From: ${from}`);
  const to = addressList(view.to);
  if (to) lines.push(`To: ${to}`);
  const cc = addressList(view.cc);
  if (cc) lines.push(`Cc: ${cc}`);
  const bcc = view.folder === "sent" && view.bcc ? addressList(view.bcc) : null;
  if (bcc) lines.push(`Bcc: ${bcc}`);
  const replyTo = view.replyTo ? addressList([view.replyTo]) : null;
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(`Subject: ${encodeHeaderText(view.subject)}`);
  if (view.rfcMessageId) lines.push(`Message-ID: ${messageId(view.rfcMessageId)}`);
  if (view.inReplyTo) lines.push(`In-Reply-To: ${messageId(view.inReplyTo)}`);
  const references = view.references.map(messageId).filter((ref) => ref !== "<>");
  if (references.length > 0) lines.push(`References: ${references.join(`${CRLF} `)}`);
  const verdicts = Object.entries(view.verdicts ?? {})
    .filter(([, value]) => typeof value === "string" && value)
    .map(([key, value]) => `${key}=${clean(String(value)).replace(/[;\s]/g, "")}`);
  if (verdicts.length > 0) lines.push(`X-Lojo-Verdicts: ${verdicts.join("; ")}`);
  lines.push("MIME-Version: 1.0");
  return lines;
}

function utf8(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

/** Deterministic for a given message and content: the boundary comes from the id, and every part is base64. */
export function buildMessage(view: MessageView, body: BodyContent, attachments: AttachmentContent[], extraHeaders: readonly string[] = []): BuiltMessage {
  const seed = hash(`lojo-bridge:${view.id}`);
  const text = body.text || (body.html ? htmlToText(body.html) : "");
  const textNode = leaf("text", "plain", [["charset", "utf-8"]], utf8(text), null);
  let content = textNode;
  if (body.html) {
    const htmlNode = leaf("text", "html", [["charset", "utf-8"]], utf8(body.html), null);
    content = multipart("alternative", `lojo-alt-${seed.slice(0, 24)}`, [textNode, htmlNode]);
  }
  let root = content;
  if (attachments.length > 0) {
    const parts = attachments.map((item) => {
      const name = paramValue(item.filename || "attachment");
      if (!item.bytes) {
        const note = `The attachment ${item.filename} could not be decrypted by the lojo-mail bridge. Open the message in the lojo-mail web app.\r\n`;
        return leaf("text", "plain", [["charset", "utf-8"], ["name", `${name}.unavailable.txt`]], utf8(note), {
          type: "attachment",
          params: [["filename", `${name}.unavailable.txt`]],
        });
      }
      const [type, subtype] = safeContentType(item.contentType);
      return leaf(type, subtype, [["name", name]], item.bytes, { type: "attachment", params: [["filename", name]] });
    });
    root = multipart("mixed", `lojo-mix-${seed.slice(24, 48)}`, [content, ...parts]);
  }
  const header = Buffer.from(`${[...topHeaders(view, extraHeaders), ...root.header.toString("latin1").split(CRLF).filter(Boolean)].join(CRLF)}${CRLF}${CRLF}`, "latin1");
  const rootBody = Buffer.concat([root.body, Buffer.from(CRLF, "latin1")]);
  const top: MimeNode = { ...root, header, body: rootBody, lines: root.children.length > 0 ? 0 : countLines(rootBody) };
  return { raw: Buffer.concat([header, rootBody]), root: top, searchText: `${text}\n${body.html ? htmlToText(body.html) : ""}` };
}

export function lockedBody(reason: string): BodyContent {
  return {
    text: `This message could not be decrypted by the lojo-mail bridge (${reason}).\r\nOpen it in the lojo-mail web app.\r\n`,
    html: "",
  };
}

/** Header block lines as they appear, with continuation lines folded into their field. */
export function headerFields(header: Buffer): Array<{ name: string; raw: string }> {
  const fields: Array<{ name: string; raw: string }> = [];
  for (const line of header.toString("latin1").split(CRLF)) {
    if (!line) continue;
    const last = fields[fields.length - 1];
    if (/^[ \t]/.test(line) && last) {
      last.raw += `${CRLF}${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    fields.push({ name: (colon > 0 ? line.slice(0, colon) : line).trim().toLowerCase(), raw: line });
  }
  return fields;
}
