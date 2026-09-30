import assert from "node:assert/strict";
import test from "node:test";
import { effectiveScopes, toolDefinitions } from "./catalog.ts";

test("effective scopes are the intersection of what was declared and what the token holds", () => {
  assert.deepEqual(effectiveScopes(["read", "write", "body"], ["read"]), ["read"]);
  assert.deepEqual(effectiveScopes(["read"], ["read", "write", "body"]), ["read"]);
  assert.deepEqual(effectiveScopes(["admin"], ["read", "write"]), ["read", "write"]);
  assert.deepEqual(effectiveScopes(["admin"], ["admin"]), ["read", "write", "send", "body"], "admin is expanded, never passed on");
});

test("tool definitions carry inline JSON Schema and honest annotations", () => {
  const defs = toolDefinitions(["read", "write", "body"]);
  const search = defs.find((tool) => tool.name === "search_mail");
  assert.deepEqual(search?.inputSchema.required, ["query"]);
  assert.equal(JSON.stringify(defs).includes("$ref"), false);
  assert.equal(search?.annotations.readOnlyHint, true);
  assert.equal(defs.find((tool) => tool.name === "read_thread")?.annotations.readOnlyHint, false, "reading clears unread flags");
  assert.ok(defs.every((tool) => tool.annotations.destructiveHint === false));
  const move = defs.find((tool) => tool.name === "move_message");
  assert.deepEqual((move?.inputSchema.properties as { folder: { enum: string[] } }).folder.enum, ["inbox", "archive", "spam"]);
});
