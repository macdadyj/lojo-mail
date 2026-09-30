import assert from "node:assert/strict";
import test from "node:test";
import { cosineInt8, packVector, rankVectors, unpackVector, vectorTag } from "./vectors.ts";

test("packing truncates, normalizes, and stays close to float cosine", () => {
  const a = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  const b = Array.from({ length: 768 }, (_, i) => Math.sin(i) + 0.3 * Math.cos(i * 3));
  const packed = packVector(a, 256);
  assert.equal(unpackVector(packed).length, 256);
  assert.equal(Buffer.from(packed, "base64").length, 256);

  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 256; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  const exact = dot / Math.sqrt(na * nb);
  const approx = cosineInt8(unpackVector(packed), unpackVector(packVector(b, 256)));
  assert.ok(Math.abs(exact - approx) < 0.01, `int8 cosine ${approx} vs float ${exact}`);
});

test("dimensions 0 keeps the native size and bad vectors are refused", () => {
  assert.equal(unpackVector(packVector([1, 2, 3], 0)).length, 3);
  assert.equal(unpackVector(packVector([1, 2, 3], 256)).length, 3);
  assert.throws(() => packVector([], 256), /empty/);
  assert.throws(() => packVector([1, Number.NaN], 256), /non-finite/);
  assert.equal(cosineInt8(unpackVector(packVector([0, 0], 0)), unpackVector(packVector([1, 1], 0))), 0);
});

test("ranking returns the closest rows first and ignores mismatched sizes", () => {
  const query = unpackVector(packVector([1, 0, 0], 0));
  const rows = [
    { id: "far", vec: packVector([0, 1, 0], 0) },
    { id: "near", vec: packVector([0.9, 0.1, 0], 0) },
    { id: "exact", vec: packVector([1, 0, 0], 0) },
    { id: "other-model", vec: packVector([1, 0, 0, 0], 0) },
  ];
  assert.deepEqual(
    rankVectors(query, rows, 5).map((row) => row.id),
    ["exact", "near"],
  );
});

test("the tag separates models and sizes", () => {
  assert.equal(vectorTag({ name: "ollama", model: "nomic-embed-text", dimensions: 256 }), "ollama/nomic-embed-text@256");
  assert.equal(vectorTag({ name: "bedrock", model: "amazon.titan-embed-text-v2:0", dimensions: 0 }), "bedrock/amazon.titan-embed-text-v2:0@native");
});
