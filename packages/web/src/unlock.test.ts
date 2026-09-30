import assert from "node:assert/strict";
import test from "node:test";
import { generateIdentity, keyFingerprint, messageBodyContext, openJson, sealJson } from "@lojo/core/crypto";
import { generateKeyPassphrase, wrapPrivateKey } from "@lojo/core/wrap";
import { currentKey, keyInfo, KeyMismatchError, lastLockReason, lockKey, onKeyChange, unlockWithJwk, unlockWithWrapped } from "./unlock.ts";

test("the web app unlocks the wrapped key into memory, refuses another mailbox's key, and locks", async () => {
  const identity = await generateIdentity();
  const other = await generateIdentity();
  const passphrase = generateKeyPassphrase();
  const blob = await wrapPrivateKey(identity.privateJwk, passphrase);
  const expected = await keyFingerprint(identity.publicJwk);
  let changes = 0;
  const unsubscribe = onKeyChange(() => {
    changes += 1;
  });

  const otherBlob = await wrapPrivateKey(other.privateJwk, passphrase);
  await assert.rejects(() => unlockWithWrapped(otherBlob, passphrase, { expectedFingerprint: expected }), KeyMismatchError);
  assert.equal(currentKey(), null);
  await assert.rejects(() => unlockWithWrapped(blob, generateKeyPassphrase(), { expectedFingerprint: expected }), /Wrong key passphrase/);

  const progress: number[] = [];
  const result = await unlockWithWrapped(blob, passphrase.toLowerCase(), { expectedFingerprint: expected, onProgress: (fraction) => progress.push(fraction) });
  assert.equal(result.info.fingerprint, expected);
  assert.equal(result.info.source, "wrapped");
  assert.ok(progress.length > 0 && (progress.at(-1) ?? 0) >= 0.99, "the KDF reports progress for the button");
  const key = currentKey();
  assert.ok(key);
  assert.equal(key.extractable, false);
  const sealed = await sealJson({ text: "hi" }, identity.publicJwk, messageBodyContext("m"));
  assert.deepEqual(await openJson(sealed, key, messageBodyContext("m")), { text: "hi" });

  lockKey("manual");
  assert.equal(currentKey(), null);
  assert.equal(keyInfo(), null);
  assert.equal(lastLockReason(), "manual");
  assert.equal(changes, 2, "unlock and lock both notify");

  await assert.rejects(() => unlockWithJwk(other.privateJwk, expected), KeyMismatchError);
  const info = await unlockWithJwk(identity.privateJwk, expected);
  assert.equal(info.source, "jwk");
  assert.equal(currentKey()?.extractable, false);
  lockKey("manual");
  unsubscribe();
});
