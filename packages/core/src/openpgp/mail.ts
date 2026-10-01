import * as openpgp from "openpgp";

export interface PgpSigningKey {
  armoredKey: string;
  passphrase?: string;
}

/** Encrypts to every key given (all recipients plus Jon's own), and signs when a signing key is supplied. */
export async function encryptText(text: string, armoredPublicKeys: string[], signing?: PgpSigningKey): Promise<string> {
  return encryptMessage(await openpgp.createMessage({ text }), armoredPublicKeys, signing);
}

/** PGP/MIME (RFC 3156): the whole MIME body entity, encrypted (and signed) as one binary OpenPGP message. */
export async function encryptMimeEntity(entity: string, armoredPublicKeys: string[], signing?: PgpSigningKey): Promise<string> {
  return encryptMessage(await openpgp.createMessage({ binary: new TextEncoder().encode(entity) }), armoredPublicKeys, signing);
}

async function encryptMessage(message: openpgp.Message<string | Uint8Array>, armoredPublicKeys: string[], signing?: PgpSigningKey): Promise<string> {
  if (armoredPublicKeys.length === 0) throw new Error("No OpenPGP recipient keys");
  const encryptionKeys = await Promise.all(armoredPublicKeys.map((armoredKey) => openpgp.readKey({ armoredKey })));
  let signingKeys: openpgp.PrivateKey | undefined;
  if (signing) {
    const locked = await openpgp.readPrivateKey({ armoredKey: signing.armoredKey });
    signingKeys = signing.passphrase ? await openpgp.decryptKey({ privateKey: locked, passphrase: signing.passphrase }) : locked;
  }
  const encrypted = await openpgp.encrypt({ message, encryptionKeys, ...(signingKeys ? { signingKeys } : {}), format: "armored" });
  if (typeof encrypted !== "string") {
    throw new Error("Expected armored OpenPGP output");
  }
  return encrypted;
}

export async function decryptText(
  armored: string,
  armoredPrivateKey: string,
  passphrase: string,
  verifyWith?: string,
): Promise<{ text: string; signed: boolean }> {
  const message = await openpgp.readMessage({ armoredMessage: armored });
  const locked = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
  const decryptionKeys = await openpgp.decryptKey({ privateKey: locked, passphrase });
  const verificationKeys = verifyWith ? await openpgp.readKey({ armoredKey: verifyWith }) : undefined;
  const decrypted = await openpgp.decrypt({ message, decryptionKeys, ...(verificationKeys ? { verificationKeys } : {}) });
  if (typeof decrypted.data !== "string") {
    throw new Error("Expected text OpenPGP payload");
  }
  let signed = false;
  const first = decrypted.signatures[0];
  if (verificationKeys && first) {
    signed = await first.verified.then(() => true).catch(() => false);
  }
  return { text: decrypted.data, signed };
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
