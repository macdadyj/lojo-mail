import {
  attachmentContext,
  decodeEnvelope,
  messageBodyContext,
  openBytes,
  openJson,
  type EcPrivateJwk,
  type EnvelopeBlob,
} from "@lojo/core/crypto";
import { api, raw } from "./api.ts";
import type { AttachmentMeta, AttachmentResponse, BodyResponse, Message, SealedBody } from "./types.ts";

const SESSION_KEY = "lojo-mail-private-jwk";
let privateJwk: EcPrivateJwk | null = null;

export function rememberKey(jwk: EcPrivateJwk | null, persist: boolean): void {
  privateJwk = jwk;
  if (persist && jwk) sessionStorage.setItem(SESSION_KEY, JSON.stringify(jwk));
  else sessionStorage.removeItem(SESSION_KEY);
}

export function loadRememberedKey(): EcPrivateJwk | null {
  if (privateJwk) return privateJwk;
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return null;
  try {
    privateJwk = JSON.parse(stored) as EcPrivateJwk;
    return privateJwk;
  } catch {
    return null;
  }
}

export function hasPrivateKey(): boolean {
  return loadRememberedKey() !== null;
}

export function isKeyPersisted(): boolean {
  return sessionStorage.getItem(SESSION_KEY) !== null;
}

/** Fetches the sealed body and opens it with the key held in this tab. Returns the message unchanged without a key. */
export async function openMessage(message: Message): Promise<Message> {
  if (!message.locked) return message;
  const key = loadRememberedKey();
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
    const key = loadRememberedKey();
    if (!key) throw new Error("This attachment is sealed. Load the envelope key in Settings first.");
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
