import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { hasScope, tokenBookFromEnv, TokenBook } from "./auth.ts";
import { MemoryStore } from "@lojo/core";
import {
  DEV_PASSPHRASE,
  LOGIN_FAILURES_PER_SOURCE,
  LOGIN_WINDOW_MS,
  LoginRateLimited,
  LoginThrottle,
  Sessions,
  devSessions,
  hashPassphrase,
  sourceKey,
  verifyPassphrase,
} from "./session.ts";
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

test("failed sign-ins are throttled per source in a shared store, never globally", async () => {
  let clock = 0;
  const store = new MemoryStore();
  const first = new LoginThrottle(store, { now: () => clock });
  const secondContainer = new LoginThrottle(store, { now: () => clock });
  const attacker = sourceKey("203.0.113.9");
  for (let i = 0; i < LOGIN_FAILURES_PER_SOURCE; i += 1) {
    await (i % 2 === 0 ? first : secondContainer).check(attacker);
    await (i % 2 === 0 ? first : secondContainer).fail(attacker);
  }
  await assert.rejects(() => first.check(attacker), LoginRateLimited);
  await assert.rejects(() => secondContainer.check(attacker), LoginRateLimited, "the count is shared across containers");
  await first.check(sourceKey("198.51.100.4"));
  clock += LOGIN_WINDOW_MS;
  await first.check(attacker);
});

test("throttle keys: IPv4, IPv4-mapped, IPv6 grouped by /64, and garbage", () => {
  assert.equal(sourceKey("203.0.113.9"), "203.0.113.9");
  assert.equal(sourceKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(sourceKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(sourceKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
  assert.equal(sourceKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(sourceKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(sourceKey(undefined), "unknown");
  assert.equal(sourceKey("not an address"), "unknown");
});

test("the dev passphrase is refused in production", () => {
  assert.throws(() => devSessions({}, true), /Refusing the dev passphrase/);
  assert.ok(devSessions({}, false));
  assert.ok(devSessions({ LOJO_HUMAN_PASSPHRASE: "a real long passphrase" }, true));
  assert.equal(DEV_PASSPHRASE.length >= 12, true);
});

test("login over HTTP: 401 on a wrong passphrase, then a human principal", async () => {
  const t = await testApp();
  const wrong = await t.call("/v1/session/login", { body: { passphrase: "not the passphrase" } });
  assert.equal(wrong.status, 401);
  const token = await t.login();
  const who = await t.call("/v1/session", { token });
  assert.deepEqual(who.json, { kind: "human", label: "jon", scopes: ["admin"] });
  assert.equal((await t.call("/v1/session", { token: "admin-token" })).json.kind, "token");
});

test("an attacker hammering sign-in gets 429 for its own address; Jon still signs in from his", async () => {
  let clock = Date.parse("2026-09-29T12:00:00Z");
  const t = await testApp({ now: () => new Date(clock) });
  const attacker = { "x-test-source-ip": "203.0.113.9" };
  const jon = { "x-test-source-ip": "198.51.100.4" };
  for (let i = 0; i < LOGIN_FAILURES_PER_SOURCE; i += 1) {
    assert.equal((await t.call("/v1/session/login", { body: { passphrase: "nope nope nope" }, headers: attacker })).status, 401);
  }
  const locked = await t.call("/v1/session/login", { body: { passphrase: TEST_PASSPHRASE }, headers: attacker });
  assert.equal(locked.status, 429, "even the right passphrase waits out the window from that source");
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  const ownV6 = await t.call("/v1/session/login", { body: { passphrase: "nope nope nope" }, headers: { "x-test-source-ip": "2001:db8:1:2::1" } });
  assert.equal(ownV6.status, 401);
  const signedIn = await t.call("/v1/session/login", { body: { passphrase: TEST_PASSPHRASE }, headers: jon });
  assert.equal(signedIn.status, 200, "no global lockout");
  clock += LOGIN_WINDOW_MS;
  assert.equal((await t.call("/v1/session/login", { body: { passphrase: TEST_PASSPHRASE }, headers: attacker })).status, 200);
});
