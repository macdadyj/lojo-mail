import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { before, describe, it } from "node:test";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { EcPrivateJwk, EcPublicJwk } from "../types.ts";
import { generateIdentity, keyFingerprint, messageBodyContext, openJson, sealJson } from "./envelope.ts";
import {
  decryptWrappedKey,
  generateKeyPassphrase,
  MIN_SCRYPT_N,
  normalizeKeyPassphrase,
  parseWrappedKey,
  unwrapPrivateKey,
  unwrapToJwk,
  wrapPrivateKey,
  WRAPPED_KEY_PREFIX,
  WrappedKeyError,
} from "./wrap.ts";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function reencode(blob: string, change: (fields: Record<string, unknown>) => void): string {
  const fields = JSON.parse(Buffer.from(blob.slice(WRAPPED_KEY_PREFIX.length), "base64url").toString("utf8")) as Record<string, unknown>;
  change(fields);
  return WRAPPED_KEY_PREFIX + b64url(fields);
}

describe("passphrase-wrapped envelope key", () => {
  let identity: { publicJwk: EcPublicJwk; privateJwk: EcPrivateJwk };
  let passphrase: string;
  let blob: string;

  before(async () => {
    identity = await generateIdentity();
    passphrase = generateKeyPassphrase();
    blob = await wrapPrivateKey(identity.privateJwk, passphrase, { now: new Date("2026-09-30T12:00:00Z") });
  });

  it("generates 150-bit Crockford passphrases and accepts them however they are typed", () => {
    assert.match(passphrase, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
    assert.notEqual(generateKeyPassphrase(), passphrase);
    const typed = passphrase.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    assert.equal(normalizeKeyPassphrase(typed), passphrase.replace(/-/g, ""));
    assert.throws(() => normalizeKeyPassphrase("correct horse battery staple"), WrappedKeyError);
    assert.throws(() => normalizeKeyPassphrase(passphrase.slice(0, -1)), WrappedKeyError);
  });

  it("is one short line with the public key, KDF parameters and no private material in the clear", () => {
    assert.ok(blob.startsWith(WRAPPED_KEY_PREFIX));
    assert.ok(blob.length < 700, `blob is ${blob.length} chars`);
    assert.doesNotMatch(blob, /\s/);
    const parsed = parseWrappedKey(blob);
    assert.equal(parsed.kdf, "scrypt");
    assert.equal(parsed.N, MIN_SCRYPT_N);
    assert.equal(parsed.r, 8);
    assert.equal(parsed.x, identity.publicJwk.x);
    assert.equal(parsed.created, "2026-09-30T12:00:00.000Z");
    assert.ok(!JSON.stringify(parsed).includes(identity.privateJwk.d), "d never appears");
  });

  it("uses a fresh salt and IV every time", async () => {
    const again = parseWrappedKey(await wrapPrivateKey(identity.privateJwk, passphrase));
    const first = parseWrappedKey(blob);
    assert.notEqual(again.salt, first.salt);
    assert.notEqual(again.iv, first.iv);
    assert.notEqual(again.ct, first.ct);
  });

  it("unwraps to a non-extractable key that opens mail sealed to the mailbox", async () => {
    const sealed = await sealJson({ text: "hello Jon" }, identity.publicJwk, messageBodyContext("msg_1"));
    const unwrapped = await unwrapPrivateKey(blob.replace(/(.{60})/g, "$1\n  "), passphrase.toLowerCase());
    assert.equal(unwrapped.privateKey.extractable, false);
    assert.deepEqual(unwrapped.privateKey.usages, ["deriveBits"]);
    await assert.rejects(() => crypto.subtle.exportKey("jwk", unwrapped.privateKey));
    assert.deepEqual(await openJson(sealed, unwrapped.privateKey, messageBodyContext("msg_1")), { text: "hello Jon" });
    assert.equal(unwrapped.fingerprint, await keyFingerprint(identity.publicJwk));
    assert.match(unwrapped.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  });

  it("refuses a wrong passphrase", async () => {
    await assert.rejects(() => unwrapPrivateKey(blob, generateKeyPassphrase()), (error: unknown) => error instanceof WrappedKeyError && error.code === "passphrase");
  });

  it("refuses any change to the header, because it is bound as AAD", async () => {
    const other = await generateIdentity();
    const swappedPublic = reencode(blob, (fields) => {
      fields.x = other.publicJwk.x;
      fields.y = other.publicJwk.y;
    });
    await assert.rejects(() => unwrapPrivateKey(swappedPublic, passphrase), (error: unknown) => error instanceof WrappedKeyError && error.code === "passphrase");
    const redated = reencode(blob, (fields) => {
      fields.created = "2030-01-01T00:00:00.000Z";
    });
    await assert.rejects(() => unwrapPrivateKey(redated, passphrase), WrappedKeyError);
  });

  it("refuses weak or absurd KDF parameters before running the KDF", () => {
    for (const change of [{ N: 2 ** 14 }, { N: 2 ** 21 }, { N: 3 * 2 ** 16 }, { r: 1 }, { p: 16 }]) {
      assert.throws(
        () => parseWrappedKey(reencode(blob, (fields) => Object.assign(fields, change))),
        (error: unknown) => error instanceof WrappedKeyError && error.code === "format",
        JSON.stringify(change),
      );
    }
    assert.throws(() => parseWrappedKey("{\"kty\":\"EC\"}"), /starts with lojo-key-v1/);
    assert.throws(() => parseWrappedKey(`${WRAPPED_KEY_PREFIX}not*base64`), WrappedKeyError);
  });

  it("recovers the JWK for a new Santa", async () => {
    assert.deepEqual(await unwrapToJwk(blob, passphrase), { kty: "EC", crv: "P-256", x: identity.privateJwk.x, y: identity.privateJwk.y, d: identity.privateJwk.d });
  });

  it("decrypts to PKCS#8 bytes that the caller owns and zeroes", async () => {
    const decrypted = await decryptWrappedKey(blob, passphrase);
    assert.equal(decrypted.pkcs8[0], 0x30, "DER SEQUENCE");
    decrypted.pkcs8.fill(0);
  });

  it("the browser scrypt matches Node's native scrypt", async () => {
    const salt = new Uint8Array(16).fill(7);
    const noble = await scryptAsync("ABCDE12345", salt, { N: MIN_SCRYPT_N, r: 8, p: 1, dkLen: 32 });
    const native = scryptSync("ABCDE12345", salt, 32, { N: MIN_SCRYPT_N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    assert.ok(Buffer.from(noble).equals(native));
  });
});
