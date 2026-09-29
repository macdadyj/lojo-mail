import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "./ids.ts";
import type { Address, PgpMode } from "./types.ts";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ApprovalContent {
  from: string;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  inReplyTo?: string;
  pgp: PgpMode;
}

/** What Jon approved. Any change to recipients, subject, body, threading, or PGP mode changes the hash. */
export function approvalContentHash(content: ApprovalContent): string {
  const canonical = JSON.stringify([
    content.from.toLowerCase(),
    content.to.map((address) => address.email.toLowerCase()),
    content.cc.map((address) => address.email.toLowerCase()),
    content.subject,
    content.text,
    content.inReplyTo ?? "",
    content.pgp,
  ]);
  return sha256(canonical);
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
