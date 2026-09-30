import { test } from "node:test";
import assert from "node:assert/strict";
import { exactOrigin, securityHeaders } from "./csp.ts";

const API = "https://abc123.execute-api.us-east-1.amazonaws.com";
const BLOB = "https://lojo-mail-20260101.s3.us-east-1.amazonaws.com";

function connectSrc(policy: string): string[] {
  const directive = policy.split("; ").find((d) => d.startsWith("connect-src "));
  assert.ok(directive, policy);
  return directive.split(" ").slice(1);
}

test("[P2] CSP: an API build allows exactly the API and the mail bucket, no wildcard", () => {
  const { metaPolicy, headerPolicy } = securityHeaders({ VITE_LOJO_API_URL: `${API}/`, VITE_LOJO_BLOB_ORIGIN: BLOB });
  assert.deepEqual(connectSrc(metaPolicy), ["'self'", API, BLOB]);
  assert.deepEqual(connectSrc(headerPolicy), ["'self'", API, BLOB]);
  assert.doesNotMatch(headerPolicy, /\*/);
});

test("[P2] CSP: an API build without an exact bucket origin fails instead of falling back to a wildcard", () => {
  assert.throws(() => securityHeaders({ VITE_LOJO_API_URL: API }), /VITE_LOJO_BLOB_ORIGIN is required/);
  assert.throws(
    () => securityHeaders({ VITE_LOJO_API_URL: API, VITE_LOJO_BLOB_ORIGIN: "https://*.s3.us-east-1.amazonaws.com" }),
    /not a wildcard/,
  );
});

test("[P2] CSP: a same-origin build connects to itself only", () => {
  assert.deepEqual(connectSrc(securityHeaders({}).metaPolicy), ["'self'"]);
});

test("[P2] CSP: framing is refused by header; the meta tag omits frame-ancestors, which browsers ignore there", () => {
  const { metaPolicy, headerPolicy, headersFile } = securityHeaders({ VITE_LOJO_API_URL: API, VITE_LOJO_BLOB_ORIGIN: BLOB });
  assert.doesNotMatch(metaPolicy, /frame-ancestors/);
  assert.match(headerPolicy, /frame-ancestors 'none'/);
  assert.ok(headersFile.startsWith("/*\n"));
  assert.ok(headersFile.includes(`  Content-Security-Policy: ${headerPolicy}\n`));
  assert.ok(headersFile.includes("  X-Frame-Options: DENY\n"));
});

test("exactOrigin refuses plain http, credentials, queries, and garbage", () => {
  assert.equal(exactOrigin("http://127.0.0.1:8787", "x"), "http://127.0.0.1:8787");
  assert.equal(exactOrigin(`${BLOB}/`, "x"), BLOB);
  assert.throws(() => exactOrigin("http://example.com", "x"), /https/);
  assert.throws(() => exactOrigin("https://user:pw@example.com", "x"), /bare origin/);
  assert.throws(() => exactOrigin("https://example.com/?a=1", "x"), /bare origin/);
  assert.throws(() => exactOrigin("not a url", "x"), /absolute URL/);
});
