import assert from "node:assert/strict";
import test from "node:test";
import { generateIdentity, openJson, sealJson } from "./envelope.ts";

test("envelope round-trips json and hides plaintext", async () => {
  const { publicJwk, privateJwk } = await generateIdentity();
  const sealed = await sealJson({ text: "the cedar lease" }, publicJwk);
  assert.equal(sealed.alg, "P-256-ECDH+HKDF-SHA256+AES-256-GCM");
  assert.equal(JSON.stringify(sealed).includes("the cedar lease"), false);
  const opened = await openJson<{ text: string }>(sealed, privateJwk);
  assert.equal(opened.text, "the cedar lease");
});

test("a different private key cannot open the envelope", async () => {
  const first = await generateIdentity();
  const second = await generateIdentity();
  const sealed = await sealJson({ text: "secret" }, first.publicJwk);
  await assert.rejects(() => openJson(sealed, second.privateJwk));
});
