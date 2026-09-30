import { createHash, randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function sha256(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim();
}
