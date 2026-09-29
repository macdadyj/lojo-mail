import { MailError } from "../errors.ts";
import type { EncryptionContext, ServerSealedBlob } from "../types.ts";
import { b64ToBytes, bytesToB64 } from "./envelope.ts";

export interface DataKey {
  plaintext: Uint8Array;
  wrapped: Uint8Array;
}

/**
 * Wraps per-object data keys under a master key for one encryption context.
 * KmsKeyWrapper (pipeline) in AWS; LocalKeyWrapper for dev and tests.
 */
export interface KeyWrapper {
  generateDataKey(context: EncryptionContext): Promise<DataKey>;
  decryptDataKey(wrapped: Uint8Array, context: EncryptionContext): Promise<Uint8Array>;
}

export const SERVER_SEAL_ALG = "AES-256-GCM+wrapped-data-key" as const;

export function draftContext(draftId: string): EncryptionContext {
  return { purpose: "draft", draftId };
}

export function aiContextContext(messageId: string): EncryptionContext {
  return { purpose: "ai-context", messageId };
}

export function canonicalContext(context: EncryptionContext): string {
  const sorted = Object.keys(context)
    .sort()
    .map((key) => [key, context[key]]);
  return JSON.stringify(sorted);
}

async function aesKey(raw: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error("Data key must be 256 bits");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [usage]);
}

export async function serverSeal(value: unknown, context: EncryptionContext, wrapper: KeyWrapper): Promise<ServerSealedBlob> {
  const key = await wrapper.generateDataKey(context);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(canonicalContext(context));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad as BufferSource },
      await aesKey(key.plaintext, "encrypt"),
      plain as BufferSource,
    ),
  );
  key.plaintext.fill(0);
  return { v: 1, alg: SERVER_SEAL_ALG, ctx: { ...context }, wrappedKey: bytesToB64(key.wrapped), iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function serverOpen<T>(blob: ServerSealedBlob, expected: EncryptionContext, wrapper: KeyWrapper): Promise<T> {
  if (blob.v !== 1 || blob.alg !== SERVER_SEAL_ALG) throw new Error("Unsupported server-sealed blob");
  const canonical = canonicalContext(expected);
  if (canonicalContext(blob.ctx) !== canonical) {
    throw new MailError("Sealed blob does not belong to this object", "forbidden");
  }
  const raw = await wrapper.decryptDataKey(b64ToBytes(blob.wrappedKey), expected);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(blob.iv) as BufferSource, additionalData: new TextEncoder().encode(canonical) as BufferSource },
    await aesKey(raw, "decrypt"),
    b64ToBytes(blob.ct) as BufferSource,
  );
  raw.fill(0);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Wraps data keys with AES-GCM under a process-local master key. Never used in AWS. */
export class LocalKeyWrapper implements KeyWrapper {
  private readonly master: Uint8Array;

  constructor(master?: Uint8Array) {
    this.master = master ? new Uint8Array(master) : crypto.getRandomValues(new Uint8Array(32));
    if (this.master.byteLength !== 32) throw new Error("LocalKeyWrapper master key must be 32 bytes");
  }

  exportMaster(): Uint8Array {
    return new Uint8Array(this.master);
  }

  async generateDataKey(context: EncryptionContext): Promise<DataKey> {
    const plaintext = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(canonicalContext(context)) as BufferSource },
        await aesKey(this.master, "encrypt"),
        plaintext as BufferSource,
      ),
    );
    const wrapped = new Uint8Array(iv.byteLength + ct.byteLength);
    wrapped.set(iv, 0);
    wrapped.set(ct, iv.byteLength);
    return { plaintext: new Uint8Array(plaintext), wrapped };
  }

  async decryptDataKey(wrapped: Uint8Array, context: EncryptionContext): Promise<Uint8Array> {
    const iv = wrapped.subarray(0, 12);
    const ct = wrapped.subarray(12);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: new TextEncoder().encode(canonicalContext(context)) as BufferSource },
      await aesKey(this.master, "decrypt"),
      ct as BufferSource,
    );
    return new Uint8Array(plain);
  }
}
