import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { hasScope, tokenBookFromEnv, TokenBook } from "./auth.ts";
import { DEV_PASSPHRASE, LoginLimiter, LoginRateLimited, Sessions, devSessions, hashPassphrase, verifyPassphrase } from "./session.ts";
import { TEST_PASSPHRASE, testApp } from "./test-app.ts";

test("admin covers every scope, send does not imply write, and body is separate", () => {
  assert.equal(hasScope(["admin"], "send"), true);
  assert.equal(hasScope(["admin"], "body"), true);
  assert.equal(hasScope(["read"], "write"), false);
  assert.equal(hasScope(["send"], "write"), false);
  assert.equal(hasScope(["read", "write", "send"], "body"), false);
});

test("production refuses the well-known dev tokens", () => {
  assert.throws(() => tokenBookFromEnv({ LOJO_API_TOKEN: "dev-only-change-me" }, true));
  const book = new TokenBook(true);
  book.add("real-token", { label: "api", scopes: ["read"] });
  assert.equal(book.principal("Bearer dev-only-change-me"), null);
  assert.equal(book.principal("Bearer real-token")?.kind, "token");
});

test("local defaults: the api token has no send scope", () => {
  const book = tokenBookFromEnv({}, false);
  assert.deepEqual(book.principal("Bearer dev-only-change-me")?.scopes, ["read", "write"]);
  assert.deepEqual(book.principal("Bearer dev-read-only")?.scopes, ["read"]);
  assert.equal(book.principal("Bearer dev-send-change-me")?.scopes.includes("send"), true);
  assert.equal(book.principal("Bearer missing"), null);
});

test("API tokens cannot use the session or approval prefixes", () => {
  const book = new TokenBook(false);
  assert.throws(() => book.add("hs_forged", { label: "x", scopes: ["admin"] }), /reserved prefix/);
  assert.throws(() => book.add("apv_forged", { label: "x", scopes: ["admin"] }), /reserved prefix/);
});

test("passphrase hashes verify, reject, and enforce a minimum length", () => {
  const stored = hashPassphrase(TEST_PASSPHRASE);
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.equal(verifyPassphrase(TEST_PASSPHRASE, stored), true);
  assert.equal(verifyPassphrase(`${TEST_PASSPHRASE}!`, stored), false);
  assert.throws(() => hashPassphrase("short"), /at least 12/);
});

test("sessions are signed, expire after 12 hours, and cannot be forged", () => {
  let clock = 1_000_000;
  const sessions = new Sessions({ secret: randomBytes(32), passphraseHash: hashPassphrase(TEST_PASSPHRASE), now: () => clock });
  const { sessionToken } = sessions.login(TEST_PASSPHRASE);
  assert.match(sessionToken, /^hs_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(sessions.verify(sessionToken), true);
  const [payload] = sessionToken.slice(3).split(".");
  const other = new Sessions({ secret: randomBytes(32), passphraseHash: hashPassphrase(TEST_PASSPHRASE), now: () => clock });
  assert.equal(other.verify(sessionToken), false);
  assert.equal(sessions.verify(`hs_${payload}.AAAA`), false);
  clock += 12 * 60 * 60 * 1000 + 1;
  assert.equal(sessions.verify(sessionToken), false);
});

test("five failed sign-ins lock the container out for 15 minutes", () => {
  let clock = 0;
  const limiter = new LoginLimiter(() => clock);
  const sessions = new Sessions({ secret: randomBytes(32), passphraseHash: hashPassphrase(TEST_PASSPHRASE), now: () => clock, limiter });
  for (let i = 0; i < 5; i += 1) assert.throws(() => sessions.login("wrong passphrase!!"), /Wrong passphrase/);
  assert.throws(() => sessions.login(TEST_PASSPHRASE), LoginRateLimited);
  clock += 15 * 60 * 1000;
  assert.ok(sessions.login(TEST_PASSPHRASE).sessionToken);
});

test("the dev passphrase is refused in production", () => {
  assert.throws(() => devSessions({}, true), /Refusing the dev passphrase/);
  assert.ok(devSessions({}, false));
  assert.ok(devSessions({ LOJO_HUMAN_PASSPHRASE: "a real long passphrase" }, true));
  assert.equal(DEV_PASSPHRASE.length >= 12, true);
});

test("login over HTTP: 401 on a wrong passphrase, 429 when locked, then a human principal", async () => {
  const t = await testApp();
  const wrong = await t.call("/v1/session/login", { body: { passphrase: "not the passphrase" } });
  assert.equal(wrong.status, 401);
  const token = await t.login();
  const who = await t.call("/v1/session", { token });
  assert.deepEqual(who.json, { kind: "human", label: "jon", scopes: ["admin"] });
  assert.equal((await t.call("/v1/session", { token: "admin-token" })).json.kind, "token");
  for (let i = 0; i < 5; i += 1) await t.call("/v1/session/login", { body: { passphrase: "nope nope nope" } });
  const locked = await t.call("/v1/session/login", { body: { passphrase: TEST_PASSPHRASE } });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get("retry-after"));
});
