import { MailError } from "../errors.ts";
import type { OutboundMessage } from "../send.ts";
import type { Address } from "../types.ts";

/** Header values must never carry a line break; a decoded subject can. */
export function cleanHeaderValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/** RFC 2047 B-encoding in chunks that keep each encoded word under 75 characters. */
export function encodeHeaderText(value: string): string {
  const clean = cleanHeaderValue(value);
  if (isPrintableAscii(clean)) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const char of clean) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
}

export function cleanEmail(email: string): string {
  const clean = email.trim();
  if (!/^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+$/.test(clean)) {
    throw new MailError(`Invalid address ${JSON.stringify(email.slice(0, 80))}`, "invalid");
  }
  return clean;
}

export function formatAddress(address: Address): string {
  const email = cleanEmail(address.email);
  const name = address.name ? cleanHeaderValue(address.name) : "";
  if (!name) return email;
  if (!isPrintableAscii(name)) return `${encodeHeaderText(name)} <${email}>`;
  return `"${name.replace(/["\\]/g, "\\$&")}" <${email}>`;
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

export interface RawHeaders {
  messageId?: string;
  date?: Date;
}

/** A complete RFC 5322 message with sanitized headers and a base64 UTF-8 body. */
export function buildRawMessage(message: OutboundMessage, extra: RawHeaders = {}): string {
  const body = message.armored ?? message.text;
  const lines = [
    `From: ${formatAddress(message.from)}`,
    `To: ${message.to.map(formatAddress).join(", ")}`,
  ];
  if (message.cc.length > 0) lines.push(`Cc: ${message.cc.map(formatAddress).join(", ")}`);
  lines.push(`Subject: ${encodeHeaderText(message.subject)}`);
  lines.push(`Date: ${(extra.date ?? new Date()).toUTCString()}`);
  if (extra.messageId) lines.push(`Message-ID: <${cleanHeaderValue(extra.messageId).replace(/[<>\s]/g, "")}>`);
  if (message.inReplyTo) lines.push(`In-Reply-To: <${cleanHeaderValue(message.inReplyTo).replace(/[<>\s]/g, "")}>`);
  const references = (message.references ?? []).map((ref) => cleanHeaderValue(ref).replace(/[<>\s]/g, "")).filter(Boolean);
  if (references.length > 0) lines.push(`References: ${references.map((ref) => `<${ref}>`).join(" ")}`);
  if (message.autoReplied) {
    lines.push("Auto-Submitted: auto-replied");
    lines.push("X-Auto-Response-Suppress: All");
  }
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(wrapBase64(Buffer.from(body, "utf8").toString("base64")));
  lines.push("");
  return lines.join("\r\n");
}
