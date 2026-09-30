import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { EcPrivateJwk, EcPublicJwk } from "../types.ts";
import { keyFingerprint, openBytes, sealBytes } from "./envelope.ts";

/**
 * The envelope private key wrapped under a generated key passphrase, so Jon can
 * carry it in a password manager and unlock the web app on any device. The
 * format is one line: `lojo-key-v1.` + base64url(JSON). The plaintext is the
 * PKCS#8 encoding of the P-256 key, so a browser can import it as a
 * non-extractable key without the private scalar ever becoming a JS string.
 */
export const WRAPPED_KEY_PREFIX = "lojo-key-v1.";
const AAD_LABEL = "lojo-mail-wrapped-key-v1";
const ECDH: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };

/** OWASP's scrypt floor. Refusing anything weaker stops a swapped blob from downgrading the cost. */
export const MIN_SCRYPT_N = 2 ** 17;
const MAX_SCRYPT_N = 2 ** 20;
export const DEFAULT_SCRYPT = { N: MIN_SCRYPT_N, r: 8, p: 1 } as const;

/** Crockford base32: no I, L, O, U, so a passphrase read aloud or typed on a phone survives. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PASSPHRASE_CHARS = 30;

export interface WrappedKeyHeader {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  alg: "A256GCM";
  iv: string;
  x: string;
  y: string;
  created: string;
}

export interface WrappedKey extends WrappedKeyHeader {
  ct: string;
}

export class WrappedKeyError extends Error {
  constructor(
    message: string,
    readonly code: "format" | "passphrase" | "mismatch",
  ) {
    super(message);
    this.name = "WrappedKeyError";
  }
}

function toB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new WrappedKeyError("The wrapped key is not valid base64url", "format");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 150 random bits as 30 Crockford base32 characters in groups of five. */
export function generateKeyPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PASSPHRASE_CHARS));
  const chars = [...bytes].map((byte) => ALPHABET[byte & 31]).join("");
  bytes.fill(0);
  return chars.match(/.{5}/g)?.join("-") ?? chars;
}

/** Accepts the passphrase as shown, in any case, with or without dashes and spaces. */
export function normalizeKeyPassphrase(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== PASSPHRASE_CHARS || [...cleaned].some((char) => !ALPHABET.includes(char))) {
    throw new WrappedKeyError(`A key passphrase is ${PASSPHRASE_CHARS} letters and digits in groups of five, like ABCDE-12345-…`, "passphrase");
  }
  return cleaned;
}

function aadOf(header: WrappedKeyHeader): Uint8Array {
  const ordered: WrappedKeyHeader = {
    v: header.v,
    kdf: header.kdf,
    N: header.N,
    r: header.r,
    p: header.p,
    salt: header.salt,
    alg: header.alg,
    iv: header.iv,
    x: header.x,
    y: header.y,
    created: header.created,
  };
  return new TextEncoder().encode(`${AAD_LABEL}|${JSON.stringify(ordered)}`);
}

function checkParams(N: number, r: number, p: number): void {
  const powerOfTwo = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < MIN_SCRYPT_N || N > MAX_SCRYPT_N) throw new WrappedKeyError(`scrypt N must be a power of two from 2^17 to 2^20, not ${N}`, "format");
  if (!Number.isInteger(r) || r < 8 || r > 32) throw new WrappedKeyError(`scrypt r must be 8 to 32, not ${r}`, "format");
  if (!Number.isInteger(p) || p < 1 || p > 4) throw new WrappedKeyError(`scrypt p must be 1 to 4, not ${p}`, "format");
}

async function kek(passphrase: string, header: WrappedKeyHeader, onProgress?: (fraction: number) => void): Promise<CryptoKey> {
  const derived = await scryptAsync(normalizeKeyPassphrase(passphrase), fromB64url(header.salt), {
    N: header.N,
    r: header.r,
    p: header.p,
    dkLen: 32,
    maxmem: 1024 ** 3 + 2 * 1024,
    ...(onProgress ? { onProgress } : {}),
  });
  try {
    return await crypto.subtle.importKey("raw", derived as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally {
    derived.fill(0);
  }
}

export interface WrapOptions {
  N?: number;
  r?: number;
  p?: number;
  now?: Date;
}

/** Wraps a P-256 envelope private key under `passphrase` (use generateKeyPassphrase). */
export async function wrapPrivateKey(privateJwk: EcPrivateJwk, passphrase: string, options: WrapOptions = {}): Promise<string> {
  const N = options.N ?? DEFAULT_SCRYPT.N;
  const r = options.r ?? DEFAULT_SCRYPT.r;
  const p = options.p ?? DEFAULT_SCRYPT.p;
  checkParams(N, r, p);
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || !privateJwk.d) throw new WrappedKeyError("Expected the P-256 envelope private JWK", "format");
  const extractable = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, d: privateJwk.d, ext: true },
    ECDH,
    true,
    ["deriveBits"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", extractable));
  const header: WrappedKeyHeader = {
    v: 1,
    kdf: "scrypt",
    N,
    r,
    p,
    salt: toB64url(crypto.getRandomValues(new Uint8Array(16))),
    alg: "A256GCM",
    iv: toB64url(crypto.getRandomValues(new Uint8Array(12))),
    x: privateJwk.x,
    y: privateJwk.y,
    created: (options.now ?? new Date()).toISOString(),
  };
  try {
    const key = await kek(passphrase, header);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: fromB64url(header.iv) as BufferSource, additionalData: aadOf(header) as BufferSource }, key, pkcs8 as BufferSource),
    );
    const wrapped: WrappedKey = { ...header, ct: toB64url(ct) };
    return WRAPPED_KEY_PREFIX + toB64url(new TextEncoder().encode(JSON.stringify(wrapped)));
  } finally {
    pkcs8.fill(0);
  }
}

/** Parses and validates the blob without the passphrase. Whitespace (line wrapping in a password manager) is ignored. */
export function parseWrappedKey(text: string): WrappedKey {
  const compact = text.replace(/\s+/g, "");
  if (!compact.startsWith(WRAPPED_KEY_PREFIX)) throw new WrappedKeyError(`A wrapped key starts with ${WRAPPED_KEY_PREFIX}`, "format");
  let parsed: Partial<WrappedKey>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromB64url(compact.slice(WRAPPED_KEY_PREFIX.length)))) as Partial<WrappedKey>;
  } catch (error) {
    if (error instanceof WrappedKeyError) throw error;
    throw new WrappedKeyError("The wrapped key is damaged (not JSON inside)", "format");
  }
  const strings = ["salt", "iv", "x", "y", "created", "ct"] as const;
  if (parsed.v !== 1 || parsed.kdf !== "scrypt" || parsed.alg !== "A256GCM" || strings.some((field) => typeof parsed[field] !== "string")) {
    throw new WrappedKeyError("Unsupported or damaged wrapped key", "format");
  }
  checkParams(Number(parsed.N), Number(parsed.r), Number(parsed.p));
  return parsed as WrappedKey;
}

export interface DecryptedKey {
  /** PKCS#8 bytes of the private key. Zero them when done (importUnwrappedKey does). */
  pkcs8: Uint8Array;
  publicJwk: EcPublicJwk;
  fingerprint: string;
  created: string;
}

export async function decryptWrappedKey(text: string, passphrase: string, onProgress?: (fraction: number) => void): Promise<DecryptedKey> {
  const wrapped = parseWrappedKey(text);
  const key = await kek(passphrase, wrapped, onProgress);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64url(wrapped.iv) as BufferSource, additionalData: aadOf(wrapped) as BufferSource },
      key,
      fromB64url(wrapped.ct) as BufferSource,
    );
  } catch {
    throw new WrappedKeyError("Wrong key passphrase, or the wrapped key was changed", "passphrase");
  }
  const publicJwk: EcPublicJwk = { kty: "EC", crv: "P-256", x: wrapped.x, y: wrapped.y };
  return { pkcs8: new Uint8Array(plain), publicJwk, fingerprint: await keyFingerprint(publicJwk), created: wrapped.created };
}

/**
 * Imports PKCS#8 bytes as a non-extractable ECDH key, checks it is the private
 * half of `publicJwk` by sealing to one and opening with the other, then zeroes
 * the bytes.
 */
export async function importUnwrappedKey(pkcs8: Uint8Array, publicJwk: EcPublicJwk): Promise<CryptoKey> {
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, ECDH, false, ["deriveBits"]);
    const probe = crypto.getRandomValues(new Uint8Array(16));
    const opened = await openBytes(await sealBytes(probe, publicJwk, "lojo-mail:key-check"), privateKey, "lojo-mail:key-check").catch(() => null);
    if (!opened || opened.length !== probe.length || opened.some((byte, i) => byte !== probe[i])) {
      throw new WrappedKeyError("The unwrapped key does not match its public key", "mismatch");
    }
    return privateKey;
  } finally {
    pkcs8.fill(0);
  }
}

export interface UnwrappedKey {
  privateKey: CryptoKey;
  publicJwk: EcPublicJwk;
  fingerprint: string;
  created: string;
}

export async function unwrapPrivateKey(text: string, passphrase: string, onProgress?: (fraction: number) => void): Promise<UnwrappedKey> {
  const decrypted = await decryptWrappedKey(text, passphrase, onProgress);
  const privateKey = await importUnwrappedKey(decrypted.pkcs8, decrypted.publicJwk);
  return { privateKey, publicJwk: decrypted.publicJwk, fingerprint: decrypted.fingerprint, created: decrypted.created };
}

/** Recovery on a new Santa: back to the JWK the bridge and importer read. */
export async function unwrapToJwk(text: string, passphrase: string): Promise<EcPrivateJwk> {
  const decrypted = await decryptWrappedKey(text, passphrase);
  try {
    const key = await crypto.subtle.importKey("pkcs8", decrypted.pkcs8 as BufferSource, ECDH, true, ["deriveBits"]);
    const jwk = (await crypto.subtle.exportKey("jwk", key)) as EcPrivateJwk;
    if (jwk.x !== decrypted.publicJwk.x || jwk.y !== decrypted.publicJwk.y) throw new WrappedKeyError("The unwrapped key does not match its public key", "mismatch");
    return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
  } finally {
    decrypted.pkcs8.fill(0);
  }
}
