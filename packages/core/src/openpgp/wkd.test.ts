import assert from "node:assert/strict";
import test from "node:test";
import { decryptText, encryptText, generateTestKey } from "./mail.ts";
import { wkdAdvancedUrl, wkdLocalPartHash } from "./wkd.ts";

test("WKD local-part hash is stable z-base32 of SHA-1", () => {
  const hash = wkdLocalPartHash("Lojo");
  assert.equal(hash, wkdLocalPartHash("lojo"));
  assert.equal(hash.length, 32);
  assert.match(hash, /^[ybndrfg8ejkmcpqxot1uwisza345h769]+$/);
  assert.notEqual(hash, wkdLocalPartHash("mina"));
  assert.equal(
    wkdAdvancedUrl("cyberphysical.us", "lojo"),
    `https://openpgpkey.cyberphysical.us/.well-known/openpgpkey/cyberphysical.us/hu/${hash}`,
  );
});

test("openpgp encrypts for a recipient key", async () => {
  const recipient = await generateTestKey("ada@example.com", "test-pass");
  const armored = await encryptText("see you thursday", recipient.publicKey);
  assert.match(armored, /BEGIN PGP MESSAGE/);
  assert.equal(armored.includes("see you thursday"), false);
  const plain = await decryptText(armored, recipient.privateKey, "test-pass");
  assert.equal(plain, "see you thursday");
});
