import { randomBytes } from "node:crypto";
import { MailError } from "../errors.ts";
import type { OutboundAttachment, OutboundMessage } from "../send.ts";
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

const PARAM_CHUNK = 60;
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/**
 * A MIME header parameter. Short printable ASCII stays a quoted string; anything else is RFC 2231
 * UTF-8 percent-encoding, split into continuations so no header line nears the 998-character limit.
 */
export function mimeParameter(name: string, value: string): string {
  if (isPrintableAscii(value) && !/["\\]/.test(value) && value.length <= PARAM_CHUNK) return `${name}="${value}"`;
  const pieces = [...Buffer.from(value, "utf8")].map((byte) => {
    const char = String.fromCharCode(byte);
    return ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  });
  const chunks: string[] = [];
  let chunk = "";
  for (const piece of pieces) {
    if (chunk.length + piece.length > PARAM_CHUNK) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += piece;
  }
  chunks.push(chunk);
  if (chunks.length === 1) return `${name}*=UTF-8''${chunks[0]}`;
  return chunks.map((part, index) => `${name}*${index}*=${index === 0 ? "UTF-8''" : ""}${part}`).join(";\r\n ");
}

/** `type/subtype` in lower case with parameters dropped, or `application/octet-stream`. */
export function cleanContentType(value: string): string {
  const base = (value.split(";")[0] ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base) ? base : "application/octet-stream";
}

function boundary(): string {
  return `=_lojo_${randomBytes(12).toString("hex")}`;
}

function textPart(text: string): string[] {
  return ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrapBase64(Buffer.from(text, "utf8").toString("base64"))];
}

function attachmentPart(file: OutboundAttachment): string[] {
  return [
    `Content-Type: ${cleanContentType(file.contentType)};\r\n ${mimeParameter("name", file.filename)}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment;\r\n ${mimeParameter("filename", file.filename)}`,
    "",
    wrapBase64(Buffer.from(file.data).toString("base64")),
  ];
}

function multipart(contentType: string, preamble: string, parts: string[][]): string[] {
  const mark = boundary();
  const lines = [`Content-Type: ${contentType}; boundary="${mark}"`, "", preamble];
  for (const part of parts) lines.push(`--${mark}`, ...part);
  lines.push(`--${mark}--`);
  return lines;
}

/** The body entity (its Content-* headers, a blank line, the content): the text alone, or `multipart/mixed` with the files. */
function bodyEntity(text: string, attachments: OutboundAttachment[]): string[] {
  if (attachments.length === 0) return textPart(text);
  return multipart("multipart/mixed", "This is a multi-part message in MIME format.", [textPart(text), ...attachments.map(attachmentPart)]);
}

/** What PGP/MIME encrypts: the same body entity a plain send would carry. */
export function buildMimeEntity(message: Pick<OutboundMessage, "text" | "attachments">): string {
  return `${bodyEntity(message.text, message.attachments ?? []).join("\r\n")}\r\n`;
}

function pgpMimeEntity(armored: string): string[] {
  return multipart('multipart/encrypted; protocol="application/pgp-encrypted"', "This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)", [
    ["Content-Type: application/pgp-encrypted", "Content-Description: PGP/MIME version identification", "", "Version: 1", ""],
    [
      'Content-Type: application/octet-stream; name="encrypted.asc"',
      "Content-Description: OpenPGP encrypted message",
      'Content-Disposition: inline; filename="encrypted.asc"',
      "",
      armored.replace(/\r?\n/g, "\r\n").trimEnd(),
    ],
  ]);
}

function messageBody(message: OutboundMessage): string[] {
  if (message.pgpMime) return pgpMimeEntity(message.pgpMime);
  const attachments = message.attachments ?? [];
  if (message.armored) {
    if (attachments.length > 0) throw new Error("Inline OpenPGP cannot carry attachments; use PGP/MIME");
    return textPart(message.armored);
  }
  return bodyEntity(message.text, attachments);
}

/** A complete RFC 5322 message with sanitized headers: a base64 UTF-8 text body, `multipart/mixed` with files, or PGP/MIME. */
export function buildRawMessage(message: OutboundMessage, extra: RawHeaders = {}): string {
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
  } else if (message.botSendNew) {
    lines.push("X-Lojo-Bot: send-new");
    lines.push("X-Auto-Response-Suppress: All");
  }
  lines.push("MIME-Version: 1.0");
  lines.push(...messageBody(message));
  lines.push("");
  return lines.join("\r\n");
}
