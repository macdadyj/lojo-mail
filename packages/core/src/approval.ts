import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "./ids.ts";
import type { Address, DraftAttachment, PgpMode } from "./types.ts";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ApprovalContent {
  from: string;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  inReplyTo?: string;
  pgp: PgpMode;
  attachments?: Pick<DraftAttachment, "sha256" | "filename" | "contentType">[];
  /** Blind recipients. Omitted from the hash when empty, so older approvals still match. */
  bcc?: Address[];
}

/**
 * What Jon approved. Any change to recipients, subject, body, threading, PGP mode, or the files
 * (bytes, name, type, order) changes the hash. A draft without files hashes as it always has.
 */
export function approvalContentHash(content: ApprovalContent): string {
  const fields: unknown[] = [
    content.from.toLowerCase(),
    content.to.map((address) => address.email.toLowerCase()),
    content.cc.map((address) => address.email.toLowerCase()),
    content.subject,
    content.text,
    content.inReplyTo ?? "",
    content.pgp,
  ];
  const files = content.attachments ?? [];
  if (files.length > 0) fields.push(files.map((file) => [file.sha256.toLowerCase(), file.filename, file.contentType]));
  const bcc = content.bcc ?? [];
  if (bcc.length > 0) fields.push(bcc.map((address) => address.email.toLowerCase()));
  return sha256(JSON.stringify(fields));
}

export function newApprovalToken(): string {
  return `apv_${randomBytes(32).toString("base64url")}`;
}

export function hashApprovalToken(token: string): string {
  return sha256(token);
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
