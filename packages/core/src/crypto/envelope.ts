import type { EcPrivateJwk, EcPublicJwk, EnvelopeBlob } from "../types.ts";

export type { EcPrivateJwk, EcPublicJwk, EnvelopeBlob };

const INFO = new TextEncoder().encode("lojo-mail-envelope-v1");
const ECDH: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };

export const ENVELOPE_ALG = "P-256-ECDH+HKDF-SHA256+AES-256-GCM" as const;

/** AAD for a message body. Binds the ciphertext to the message it belongs to. */
export function messageBodyContext(messageId: string): string {
  return `lojo-mail:message:${messageId}:body`;
}

export function attachmentContext(messageId: string, attachmentId: string): string {
  return `lojo-mail:message:${messageId}:attachment:${attachmentId}`;
}

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, i + step);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function generateIdentity(): Promise<{ publicJwk: EcPublicJwk; privateJwk: EcPrivateJwk }> {
  const keys = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const publicJwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as EcPublicJwk;
  const privateJwk = (await crypto.subtle.exportKey("jwk", keys.privateKey)) as EcPrivateJwk;
  publicJwk.key_ops = [];
  return { publicJwk, privateJwk };
}

async function importPublic(jwk: EcPublicJwk): Promise<CryptoKey> {
  const copy: EcPublicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true };
  return crypto.subtle.importKey("jwk", copy, ECDH, true, []);
}

async function importPrivate(jwk: EcPrivateJwk): Promise<CryptoKey> {
  const copy: EcPrivateJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true };
  return crypto.subtle.importKey("jwk", copy, ECDH, false, ["deriveBits"]);
}

async function aesKeyFromShared(shared: ArrayBuffer, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

function requireContext(context: string): Uint8Array {
  if (!context) throw new Error("Envelope context is required");
  return new TextEncoder().encode(context);
}

export async function sealBytes(plaintext: Uint8Array, publicJwk: EcPublicJwk, context: string): Promise<EnvelopeBlob> {
  const aad = requireContext(context);
  const recipient = await importPublic(publicJwk);
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, 256);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await aesKeyFromShared(shared, "encrypt");
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad as BufferSource }, aes, plaintext as BufferSource),
  );
  const epk = (await crypto.subtle.exportKey("jwk", ephemeral.publicKey)) as EcPublicJwk;
  return {
    v: 2,
    alg: ENVELOPE_ALG,
    epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y },
    iv: bytesToB64(iv),
    ct: bytesToB64(ct),
  };
}

/** A short, stable fingerprint of the envelope public key, for comparing keys by eye. */
export async function keyFingerprint(publicJwk: Pick<EcPublicJwk, "x" | "y">): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`P-256:${publicJwk.x}:${publicJwk.y}`)));
  const hex = [...digest.subarray(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g)?.join("-") ?? hex;
}

/** Either the JWK or an already imported (typically non-extractable) ECDH private key. */
export type EnvelopePrivateKey = EcPrivateJwk | CryptoKey;

export async function openBytes(blob: EnvelopeBlob, key: EnvelopePrivateKey, context: string): Promise<Uint8Array> {
  const aad = requireContext(context);
  if (blob.v !== 2 || blob.alg !== ENVELOPE_ALG) {
    throw new Error(`Unsupported envelope ${String(blob.v)} ${String(blob.alg)}`);
  }
  const privateKey = key instanceof CryptoKey ? key : await importPrivate(key);
  const epk = await importPublic(blob.epk);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
  const aes = await aesKeyFromShared(shared, "decrypt");
  const iv = b64ToBytes(blob.iv);
  const ct = b64ToBytes(blob.ct);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
    aes,
    ct as BufferSource,
  );
  return new Uint8Array(plain);
}

export async function sealJson(value: unknown, publicJwk: EcPublicJwk, context: string): Promise<EnvelopeBlob> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return sealBytes(encoded, publicJwk, context);
}

export async function openJson<T>(blob: EnvelopeBlob, key: EnvelopePrivateKey, context: string): Promise<T> {
  const plain = await openBytes(blob, key, context);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export function encodeEnvelope(blob: EnvelopeBlob): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(blob));
}

export function decodeEnvelope(bytes: Uint8Array): EnvelopeBlob {
  return JSON.parse(new TextDecoder().decode(bytes)) as EnvelopeBlob;
}
