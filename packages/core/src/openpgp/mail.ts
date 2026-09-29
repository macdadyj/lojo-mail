import * as openpgp from "openpgp";

export async function encryptText(text: string, armoredPublicKey: string): Promise<string> {
  const message = await openpgp.createMessage({ text });
  const encryptionKeys = await openpgp.readKey({ armoredKey: armoredPublicKey });
  const encrypted = await openpgp.encrypt({ message, encryptionKeys, format: "armored" });
  if (typeof encrypted !== "string") {
    throw new Error("Expected armored OpenPGP output");
  }
  return encrypted;
}

export async function decryptText(armored: string, armoredPrivateKey: string, passphrase: string): Promise<string> {
  const message = await openpgp.readMessage({ armoredMessage: armored });
  const locked = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
  const decryptionKeys = await openpgp.decryptKey({ privateKey: locked, passphrase });
  const decrypted = await openpgp.decrypt({ message, decryptionKeys });
  if (typeof decrypted.data !== "string") {
    throw new Error("Expected text OpenPGP payload");
  }
  return decrypted.data;
}

export async function generateTestKey(email: string, passphrase: string): Promise<{ publicKey: string; privateKey: string }> {
  return openpgp.generateKey({
    type: "ecc",
    curve: "ed25519Legacy",
    userIDs: [{ name: "Test", email }],
    passphrase,
    format: "armored",
  });
}
