import assert from "node:assert/strict";
import test from "node:test";
import { attachmentContext, generateIdentity, messageBodyContext, openBytes, openJson, sealBytes, sealJson } from "./envelope.ts";
import { LocalKeyWrapper, aiContextContext, draftContext, serverOpen, serverSeal } from "./server-seal.ts";

test("envelope round-trips json and hides plaintext", async () => {
  const { publicJwk, privateJwk } = await generateIdentity();
  const sealed = await sealJson({ text: "the cedar lease" }, publicJwk, messageBodyContext("msg_a"));
  assert.equal(sealed.v, 2);
  assert.equal(sealed.alg, "P-256-ECDH+HKDF-SHA256+AES-256-GCM");
  assert.equal(JSON.stringify(sealed).includes("the cedar lease"), false);
  const opened = await openJson<{ text: string }>(sealed, privateJwk, messageBodyContext("msg_a"));
  assert.equal(opened.text, "the cedar lease");
});

test("a different private key cannot open the envelope", async () => {
  const first = await generateIdentity();
  const second = await generateIdentity();
  const sealed = await sealJson({ text: "secret" }, first.publicJwk, messageBodyContext("msg_a"));
  await assert.rejects(() => openJson(sealed, second.privateJwk, messageBodyContext("msg_a")));
});

test("an envelope only opens under its own message and part", async () => {
  const { publicJwk, privateJwk } = await generateIdentity();
  const body = await sealJson({ text: "secret" }, publicJwk, messageBodyContext("msg_a"));
  await assert.rejects(() => openJson(body, privateJwk, messageBodyContext("msg_b")));
  await assert.rejects(() => openJson(body, privateJwk, attachmentContext("msg_a", "att1")));
  const attachment = await sealBytes(new Uint8Array([1, 2, 3]), publicJwk, attachmentContext("msg_a", "att1"));
  await assert.rejects(() => openBytes(attachment, privateJwk, attachmentContext("msg_a", "att2")));
  assert.deepEqual([...(await openBytes(attachment, privateJwk, attachmentContext("msg_a", "att1")))], [1, 2, 3]);
});

test("sealing without a context is refused", async () => {
  const { publicJwk } = await generateIdentity();
  await assert.rejects(() => sealJson({ text: "x" }, publicJwk, ""), /context is required/);
});

test("server seal opens only under the context it was sealed for", async () => {
  const keys = new LocalKeyWrapper();
  const sealed = await serverSeal({ text: "draft body" }, draftContext("drf_1"), keys);
  assert.equal(JSON.stringify(sealed).includes("draft body"), false);
  assert.deepEqual(await serverOpen(sealed, draftContext("drf_1"), keys), { text: "draft body" });
  await assert.rejects(() => serverOpen(sealed, draftContext("drf_2"), keys), /does not belong/);
  await assert.rejects(() => serverOpen(sealed, aiContextContext("drf_1"), keys), /does not belong/);
  const relabelled = { ...sealed, ctx: draftContext("drf_2") };
  await assert.rejects(() => serverOpen(relabelled, draftContext("drf_2"), keys));
  await assert.rejects(() => serverOpen(sealed, draftContext("drf_1"), new LocalKeyWrapper()));
});
