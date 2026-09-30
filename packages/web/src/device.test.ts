import assert from "node:assert/strict";
import test from "node:test";
import { generateIdentity, keyFingerprint, messageBodyContext, openJson, sealJson } from "@lojo/core/crypto";
import { decryptWrappedKey, generateKeyPassphrase, importUnwrappedKey, wrapPrivateKey } from "@lojo/core/wrap";
import { DEVICE_RECORD_KEY, forgetDevice, loadDeviceRecord, openFromDevice, parseDeviceRecord, saveDeviceRecord, sealForDevice } from "./device.ts";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

test("a key remembered behind a passkey PRF opens only with that PRF output and that credential", async () => {
  const identity = await generateIdentity();
  const passphrase = generateKeyPassphrase();
  const decrypted = await decryptWrappedKey(await wrapPrivateKey(identity.privateJwk, passphrase), passphrase);
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const record = await sealForDevice(decrypted.pkcs8, prf, {
    credentialId: "cred-1",
    prfSalt: "salt",
    x: identity.publicJwk.x,
    y: identity.publicJwk.y,
    fingerprint: decrypted.fingerprint,
  });
  decrypted.pkcs8.fill(0);
  assert.ok(!JSON.stringify(record).includes(identity.privateJwk.d));

  const storage = new MemoryStorage();
  saveDeviceRecord(record, storage);
  const loaded = loadDeviceRecord(storage);
  assert.ok(loaded);
  const key = await importUnwrappedKey(await openFromDevice(loaded, prf), identity.publicJwk);
  assert.equal(key.extractable, false);
  const sealed = await sealJson({ text: "hi" }, identity.publicJwk, messageBodyContext("m"));
  assert.deepEqual(await openJson(sealed, key, messageBodyContext("m")), { text: "hi" });
  assert.equal(loaded.fingerprint, await keyFingerprint(identity.publicJwk));

  await assert.rejects(() => openFromDevice(loaded, crypto.getRandomValues(new Uint8Array(32))), /does not open/);
  await assert.rejects(() => openFromDevice({ ...loaded, credentialId: "cred-2" }, prf), /does not open/, "bound to the credential");

  forgetDevice(storage);
  assert.equal(storage.items.has(DEVICE_RECORD_KEY), false);
  assert.equal(parseDeviceRecord("{\"v\":2}"), null);
  assert.equal(parseDeviceRecord("not json"), null);
});
