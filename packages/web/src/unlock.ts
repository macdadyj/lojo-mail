import {
  attachmentContext,
  decodeEnvelope,
  keyFingerprint,
  messageBodyContext,
  openBytes,
  openJson,
  type EcPrivateJwk,
  type EnvelopeBlob,
} from "@lojo/core/crypto";
import { decryptWrappedKey, importUnwrappedKey, parseWrappedKey } from "@lojo/core/wrap";
import { api, raw, SIGNED_OUT_EVENT } from "./api.ts";
import { AutoLock, type LockReason } from "./autolock.ts";
import { enrollPasskey, loadDeviceRecord, openFromDevice, passkeyPrf, saveDeviceRecord, sealForDevice } from "./device.ts";
import type { AttachmentMeta, AttachmentResponse, BodyResponse, Message, SealedBody } from "./types.ts";

/** Earlier builds kept the raw JWK here; it is removed on start. */
const LEGACY_SESSION_KEY = "lojo-mail-private-jwk";
const IDLE_SETTING = "lojo-mail-autolock-minutes";
const WRAPPED_KEY_SETTING = "lojo-mail-wrapped-key";
export const IDLE_CHOICES = [5, 15, 60, 240] as const;
const DEFAULT_IDLE_MINUTES = 15;
/** The web session lasts 12 hours; the key never outlives that. */
const MAX_UNLOCK_MS = 12 * 60 * 60 * 1000;

export type KeySource = "wrapped" | "passkey" | "jwk";

export interface KeyInfo {
  fingerprint: string;
  source: KeySource;
  unlockedAt: number;
}

/** The envelope key, only ever as a non-extractable CryptoKey in this tab's memory. */
let held: { key: CryptoKey; info: KeyInfo } | null = null;
let lastLock: LockReason | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

const autolock = new AutoLock({
  idleMs: idleMinutes() * 60_000,
  maxMs: MAX_UNLOCK_MS,
  onLock: (reason) => {
    held = null;
    lastLock = reason;
    notify();
  },
});

export function idleMinutes(): number {
  const stored = Number(globalThis.localStorage?.getItem(IDLE_SETTING));
  return (IDLE_CHOICES as readonly number[]).includes(stored) ? stored : DEFAULT_IDLE_MINUTES;
}

export function setIdleMinutes(minutes: number): void {
  localStorage.setItem(IDLE_SETTING, String(minutes));
  autolock.setIdle(minutes * 60_000);
}

export function onKeyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentKey(): CryptoKey | null {
  if (held && autolock.check()) return null;
  return held?.key ?? null;
}

export function keyInfo(): KeyInfo | null {
  return currentKey() ? (held?.info ?? null) : null;
}

export function hasPrivateKey(): boolean {
  return currentKey() !== null;
}

export function lastLockReason(): LockReason | null {
  return lastLock;
}

function holdKey(key: CryptoKey, fingerprint: string, source: KeySource): KeyInfo {
  const info = { fingerprint, source, unlockedAt: Date.now() };
  held = { key, info };
  lastLock = null;
  autolock.start();
  notify();
  return info;
}

export function lockKey(reason: LockReason = "manual"): void {
  if (autolock.running) autolock.lock(reason);
  else if (held) {
    held = null;
    lastLock = reason;
    notify();
  }
}

/** Activity keeps the key; hiding the tab past the deadline, or signing out, locks it. Call once at startup. */
export function installKeyWatch(): void {
  sessionStorage.removeItem(LEGACY_SESSION_KEY);
  const touch = () => autolock.touch();
  for (const event of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(event, touch, { passive: true });
  document.addEventListener("visibilitychange", () => autolock.check());
  window.addEventListener(SIGNED_OUT_EVENT, () => lockKey("signed-out"));
}

/** Only the wrapped blob, never the passphrase; it is useless without the passphrase. */
export function savedWrappedKey(): string | null {
  return globalThis.localStorage?.getItem(WRAPPED_KEY_SETTING) ?? null;
}

export function saveWrappedKey(blob: string | null): void {
  if (blob) localStorage.setItem(WRAPPED_KEY_SETTING, blob.replace(/\s+/g, ""));
  else localStorage.removeItem(WRAPPED_KEY_SETTING);
}

export class KeyMismatchError extends Error {}

export interface WrappedUnlock {
  info: KeyInfo;
  /** Set when unlocking worked but the passkey step did not. */
  rememberError?: string;
}

export async function unlockWithWrapped(
  blob: string,
  passphrase: string,
  options: { expectedFingerprint?: string; rememberDevice?: { mailbox: string }; onProgress?: (fraction: number) => void },
): Promise<WrappedUnlock> {
  parseWrappedKey(blob);
  const decrypted = await decryptWrappedKey(blob, passphrase, options.onProgress);
  try {
    if (options.expectedFingerprint && decrypted.fingerprint !== options.expectedFingerprint) {
      throw new KeyMismatchError(
        `This wrapped key (fingerprint ${decrypted.fingerprint}) is not the key this mailbox seals to (${options.expectedFingerprint}). Export it again on Santa.`,
      );
    }
    let rememberError: string | undefined;
    if (options.rememberDevice) {
      try {
        const passkey = await enrollPasskey(options.rememberDevice.mailbox);
        saveDeviceRecord(
          await sealForDevice(decrypted.pkcs8, passkey.prfOutput, {
            credentialId: passkey.credentialId,
            prfSalt: passkey.prfSalt,
            x: decrypted.publicJwk.x,
            y: decrypted.publicJwk.y,
            fingerprint: decrypted.fingerprint,
          }),
        );
        passkey.prfOutput.fill(0);
      } catch (error) {
        rememberError = error instanceof Error ? error.message : "The passkey step failed";
      }
    }
    const key = await importUnwrappedKey(decrypted.pkcs8, decrypted.publicJwk);
    return { info: holdKey(key, decrypted.fingerprint, "wrapped"), ...(rememberError ? { rememberError } : {}) };
  } finally {
    decrypted.pkcs8.fill(0);
  }
}

export async function unlockWithPasskey(): Promise<KeyInfo> {
  const record = loadDeviceRecord();
  if (!record) throw new Error("This device does not remember the key");
  const prf = await passkeyPrf(record);
  try {
    const pkcs8 = await openFromDevice(record, prf);
    const key = await importUnwrappedKey(pkcs8, { kty: "EC", crv: "P-256", x: record.x, y: record.y });
    return holdKey(key, record.fingerprint, "passkey");
  } finally {
    prf.fill(0);
  }
}

/** For Santa and development: the raw JWK, imported non-extractable and held in memory only. */
export async function unlockWithJwk(jwk: EcPrivateJwk, expectedFingerprint?: string): Promise<KeyInfo> {
  const fingerprint = await keyFingerprint(jwk);
  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    throw new KeyMismatchError(`This key (fingerprint ${fingerprint}) is not the key this mailbox seals to (${expectedFingerprint}).`);
  }
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  return holdKey(key, fingerprint, "jwk");
}

/** Fetches the sealed body and opens it with the key held in this tab. Returns the message unchanged without a key. */
export async function openMessage(message: Message): Promise<Message> {
  if (!message.locked) return message;
  const key = currentKey();
  if (!key) return message;
  const { envelope } = await api<BodyResponse>(`/v1/messages/${encodeURIComponent(message.id)}/body`);
  const body = await openJson<SealedBody>(envelope, key, messageBodyContext(message.id));
  return {
    ...message,
    locked: false,
    text: body.text,
    summary: body.ai?.summary,
    threadSummary: body.ai?.threadSummary,
    actionItems: body.ai?.actionItems,
    draftReply: body.ai?.draftReply,
    phishingReasons: body.ai?.phishingReasons,
  };
}

export async function downloadAttachment(messageId: string, attachment: AttachmentMeta): Promise<void> {
  const path = `/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`;
  const response = await raw(path);
  let bytes: Uint8Array;
  if (response.headers.get("content-type")?.includes("application/json")) {
    const payload = (await response.json()) as AttachmentResponse;
    const envelope = "url" in payload ? await fetchEnvelope(payload.url) : payload.envelope;
    const key = currentKey();
    if (!key) throw new Error("This attachment is sealed. Unlock the envelope key in Settings first.");
    bytes = await openBytes(envelope, key, attachmentContext(messageId, attachment.id));
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.filename || "attachment";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Large attachments come as a short-lived presigned S3 URL to the sealed object. */
async function fetchEnvelope(url: string): Promise<EnvelopeBlob> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`Attachment download failed (${response.status})`);
  return decodeEnvelope(new Uint8Array(await response.arrayBuffer()));
}

export function parsePrivateJwk(text: string): EcPrivateJwk {
  const parsed = JSON.parse(text) as Partial<EcPrivateJwk>;
  if (parsed.kty !== "EC" || parsed.crv !== "P-256" || !parsed.x || !parsed.y || !parsed.d) {
    throw new Error("Paste the envelope private JWK (P-256, including d).");
  }
  return { kty: "EC", crv: "P-256", x: parsed.x, y: parsed.y, d: parsed.d };
}
