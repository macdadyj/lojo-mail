import type { Embedder } from "./types.ts";

/**
 * Vectors are stored on the message item as base64 int8: truncated to the
 * configured size (Matryoshka-style), L2-normalized, scaled by 127. At 256
 * dimensions that is 344 bytes per message, so a whole mailbox's vectors come
 * back from one sparse-index query and are ranked in memory.
 */
export function packVector(vector: readonly number[], dimensions: number): string {
  const size = dimensions > 0 ? Math.min(dimensions, vector.length) : vector.length;
  if (size === 0) throw new Error("Cannot store an empty vector");
  let norm = 0;
  for (let i = 0; i < size; i += 1) {
    const value = vector[i] ?? 0;
    if (!Number.isFinite(value)) throw new Error("Embedding contains a non-finite value");
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  const out = new Int8Array(size);
  if (norm > 0) {
    for (let i = 0; i < size; i += 1) out[i] = Math.max(-127, Math.min(127, Math.round(((vector[i] ?? 0) / norm) * 127)));
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString("base64");
}

export function unpackVector(packed: string): Int8Array {
  const bytes = Buffer.from(packed, "base64");
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function cosineInt8(a: Int8Array, b: Int8Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Vectors from different models or sizes are not comparable, so each lives under its own tag. */
export function vectorTag(embedder: Pick<Embedder, "name" | "model" | "dimensions">): string {
  return `${embedder.name}/${embedder.model}@${embedder.dimensions > 0 ? embedder.dimensions : "native"}`;
}

export interface VectorRow {
  id: string;
  vec: string;
}

export function rankVectors(query: Int8Array, rows: readonly VectorRow[], limit: number, minScore = 0): Array<{ id: string; score: number }> {
  const scored: Array<{ id: string; score: number }> = [];
  for (const row of rows) {
    const score = cosineInt8(query, unpackVector(row.vec));
    if (score > minScore) scored.push({ id: row.id, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
