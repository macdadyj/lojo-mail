/**
 * "Remember on this device": the PKCS#8 envelope key sealed under a secret
 * that only a passkey on this device can produce (the WebAuthn PRF
 * extension). The sealed record sits in localStorage; opening it needs the
 * passkey and user verification (fingerprint, face, or device PIN) every time.
 * Without PRF support the option stays off: there is no weaker fallback.
 */

export const DEVICE_RECORD_KEY = "lojo-mail-device-key";
const INFO = new TextEncoder().encode("lojo-mail-device-key-v1");

export interface DeviceRecord {
  v: 1;
  credentialId: string;
  prfSalt: string;
  iv: string;
  ct: string;
  x: string;
  y: string;
  fingerprint: string;
  created: string;
}

function toB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function aad(record: Pick<DeviceRecord, "credentialId" | "x" | "y">): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`lojo-mail-device-key-v1|${record.credentialId}|${record.x}|${record.y}`);
}

async function aesFromPrf(prfOutput: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", prfOutput as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO }, ikm, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealForDevice(
  pkcs8: Uint8Array,
  prfOutput: Uint8Array,
  meta: { credentialId: string; prfSalt: string; x: string; y: string; fingerprint: string; now?: Date },
): Promise<DeviceRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = { credentialId: meta.credentialId, x: meta.x, y: meta.y };
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(base) }, await aesFromPrf(prfOutput), pkcs8 as BufferSource));
  return {
    v: 1,
    credentialId: meta.credentialId,
    prfSalt: meta.prfSalt,
    iv: toB64url(iv),
    ct: toB64url(ct),
    x: meta.x,
    y: meta.y,
    fingerprint: meta.fingerprint,
    created: (meta.now ?? new Date()).toISOString(),
  };
}

/** Returns the PKCS#8 bytes; the caller imports them (importUnwrappedKey zeroes them). */
export async function openFromDevice(record: DeviceRecord, prfOutput: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(record.iv), additionalData: aad(record) }, await aesFromPrf(prfOutput), fromB64url(record.ct)),
    );
  } catch {
    throw new Error("This passkey does not open the key remembered on this device. Forget the device and unlock with the wrapped key again.");
  }
}

export function parseDeviceRecord(text: string | null): DeviceRecord | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<DeviceRecord>;
    const fields = ["credentialId", "prfSalt", "iv", "ct", "x", "y", "fingerprint", "created"] as const;
    if (parsed.v !== 1 || fields.some((field) => typeof parsed[field] !== "string")) return null;
    return parsed as DeviceRecord;
  } catch {
    return null;
  }
}

export function loadDeviceRecord(storage: Pick<Storage, "getItem"> = localStorage): DeviceRecord | null {
  return parseDeviceRecord(storage.getItem(DEVICE_RECORD_KEY));
}

export function saveDeviceRecord(record: DeviceRecord, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(DEVICE_RECORD_KEY, JSON.stringify(record));
}

export function forgetDevice(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(DEVICE_RECORD_KEY);
}

/** "no" when the browser says it cannot do PRF; "maybe" when it cannot say (the attempt will tell). */
export async function passkeyPrfSupport(): Promise<"no" | "maybe" | "yes"> {
  if (typeof PublicKeyCredential === "undefined" || !window.isSecureContext) return "no";
  const withCaps = PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
  if (!withCaps.getClientCapabilities) return "maybe";
  try {
    const caps = await withCaps.getClientCapabilities();
    if (caps["extension:prf"] === true) return "yes";
    return caps["extension:prf"] === false ? "no" : "maybe";
  } catch {
    return "maybe";
  }
}

function prfFirst(credential: Credential | null): Uint8Array | null {
  if (!(credential instanceof PublicKeyCredential)) return null;
  const first = credential.getClientExtensionResults().prf?.results?.first;
  if (!first) return null;
  return first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
}

async function evaluate(credentialId: string, prfSalt: string): Promise<Uint8Array> {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: fromB64url(credentialId) }],
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { eval: { first: fromB64url(prfSalt) } } },
    },
  });
  const output = prfFirst(credential);
  if (!output) throw new Error("This passkey or browser does not support the PRF extension, so the key cannot be remembered on this device.");
  return output;
}

/** Creates a passkey for this device and returns its PRF output for a new random salt. */
export async function enrollPasskey(mailbox: string): Promise<{ credentialId: string; prfSalt: string; prfOutput: Uint8Array }> {
  const prfSalt = toB64url(crypto.getRandomValues(new Uint8Array(32)));
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: "lojo-mail" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: mailbox, displayName: `${mailbox} key on this device` },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
      timeout: 120_000,
      extensions: { prf: { eval: { first: fromB64url(prfSalt) } } },
    },
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("No passkey was created");
  const credentialId = toB64url(new Uint8Array(credential.rawId));
  if (credential.getClientExtensionResults().prf?.enabled === false) {
    throw new Error("This passkey does not support the PRF extension, so the key cannot be remembered on this device.");
  }
  const prfOutput = prfFirst(credential) ?? (await evaluate(credentialId, prfSalt));
  return { credentialId, prfSalt, prfOutput };
}

export function passkeyPrf(record: DeviceRecord): Promise<Uint8Array> {
  return evaluate(record.credentialId, record.prfSalt);
}
