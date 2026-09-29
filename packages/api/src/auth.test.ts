import assert from "node:assert/strict";
import test from "node:test";
import { hasScope, tokenBookFromEnv, TokenBook } from "./auth.ts";

test("admin covers every scope and send does not imply write", () => {
  assert.equal(hasScope(["admin"], "send"), true);
  assert.equal(hasScope(["read"], "write"), false);
  assert.equal(hasScope(["send"], "write"), false);
  assert.equal(hasScope(["read", "write", "send"], "send"), true);
});

test("production refuses the well-known dev tokens", () => {
  assert.throws(() => tokenBookFromEnv({ LOJO_API_TOKEN: "dev-only-change-me" }, true));
  const book = new TokenBook(true);
  book.add("real-token", { label: "api", scopes: ["read"] });
  assert.equal(book.principal("Bearer dev-only-change-me"), null);
  assert.equal(book.principal("Bearer real-token")?.label, "api");
});

test("local defaults include a read-only token and a send token", () => {
  const book = tokenBookFromEnv({}, false);
  assert.deepEqual(book.principal("Bearer dev-read-only")?.scopes, ["read"]);
  assert.equal(book.principal("Bearer dev-send-change-me")?.scopes.includes("send"), true);
  assert.equal(book.principal("Bearer missing"), null);
});
