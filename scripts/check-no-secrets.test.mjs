import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { scanText } from "./check-no-secrets.mjs";

// Keys are generated here so no key material is ever written into the repo.
function p256Jwk() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateJwk: privateKey.export({ format: "jwk" }), publicJwk: publicKey.export({ format: "jwk" }) };
}

test("a private envelope JWK is flagged, compact or pretty-printed", () => {
  const { privateJwk } = p256Jwk();
  assert.deepEqual(scanText(JSON.stringify(privateJwk)), ["private JWK (d)"]);
  assert.deepEqual(scanText(JSON.stringify(privateJwk, null, 2)), ["private JWK (d)"]);
  assert.deepEqual(scanText(`const key = { kty: "EC", crv: "P-256", d: '${privateJwk.d}' };`), ["private JWK (d)"]);
});

test("a public JWK and documentation placeholders are not flagged", () => {
  const { publicJwk } = p256Jwk();
  assert.deepEqual(scanText(JSON.stringify(publicJwk)), []);
  assert.deepEqual(scanText('{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…"}'), []);
  assert.deepEqual(scanText('if (!jwk.d || !parsed.d) throw new Error("d is required");'), []);
});

test("the older patterns still match", () => {
  const header = ["-----BEGIN", "PGP PRIVATE KEY BLOCK-----"].join(" ");
  assert.deepEqual(scanText(header), ["PGP private key"]);
  assert.deepEqual(scanText(`id = ${"AKIA"}${"Z".repeat(16)}`), ["AWS access key id"]);
});
