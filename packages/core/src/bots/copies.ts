import { botCopyKey, type BlobStore } from "../blob/store.ts";
import { decodeEnvelope, encodeEnvelope, ENVELOPE_ALG, sealJson } from "../crypto/envelope.ts";
import { MailError } from "../errors.ts";
import type { MailStore } from "../store/types.ts";
import type { EnvelopeBlob, StoredMessage } from "../types.ts";
import type { BotEnvelopeKey, BotRegistry } from "./registry.ts";

/** What a bot can read of a message. Not the sealed AI output, not attachments. */
export interface BotBody {
  text: string;
  html: string;
}

/** AAD for a bot copy: binds it to one message and one bot key. */
export function botBodyContext(messageId: string, keyId: string): string {
  return `lojo-mail:message:${messageId}:bot-body:${keyId}`;
}

export function activeBotKey(registry: BotRegistry | null): BotEnvelopeKey | null {
  return registry?.envelopeKey ?? null;
}

const MAX_COPY_BYTES = 2_000_000;

/** Seals and stores the copy. The caller records `botBodyKey`/`botKeyId` on the message. */
export async function sealBotCopy(blobs: BlobStore, messageId: string, key: BotEnvelopeKey, body: BotBody): Promise<{ botBodyKey: string; botKeyId: string }> {
  const blobKey = botCopyKey(messageId, key.keyId);
  const sealed = await sealJson({ text: body.text, html: body.html }, key.publicJwk, botBodyContext(messageId, key.keyId));
  await blobs.put(blobKey, encodeEnvelope(sealed), "application/json");
  return { botBodyKey: blobKey, botKeyId: key.keyId };
}

/**
 * The sealed copy for the bot key Jon has registered now. A copy made for an
 * earlier key is never served: removing or replacing the key cuts the bot off
 * from it, whether or not the old private key was destroyed.
 */
export async function readBotCopy(store: MailStore, blobs: BlobStore, messageId: string): Promise<{ keyId: string; envelope: EnvelopeBlob }> {
  const key = activeBotKey(await store.getBotRegistry());
  if (!key) throw new MailError("No bot envelope key is registered, so bots cannot read message bodies", "not_found");
  const message = await store.getMessage(messageId);
  if (!message) throw new MailError(`No message ${messageId}`, "not_found");
  if (message.botKeyId !== key.keyId || message.botBodyKey !== botCopyKey(message.id, key.keyId)) {
    throw new MailError("This message has no copy for the current bot key. Jon can add one with lojo-bot admin backfill.", "not_found");
  }
  const bytes = await blobs.get(message.botBodyKey);
  if (!bytes) throw new MailError("The bot copy is missing", "not_found");
  return { keyId: key.keyId, envelope: decodeEnvelope(bytes) };
}

/** Newest first: messages without a copy for the current key. Jon's backfill opens each with his key and seals it again for the bot. */
export async function botBackfillCandidates(store: MailStore, limit: number): Promise<{ keyId: string | null; messageIds: string[] }> {
  const key = activeBotKey(await store.getBotRegistry());
  if (!key) return { keyId: null, messageIds: [] };
  const messages = await store.listMessages({ limit: 1000 });
  const missing = messages.filter((message: StoredMessage) => message.folder !== "trash" && message.botKeyId !== key.keyId);
  return { keyId: key.keyId, messageIds: missing.slice(0, limit).map((message) => message.id) };
}

function isEnvelope(value: unknown): value is EnvelopeBlob {
  const blob = (value ?? {}) as Partial<EnvelopeBlob>;
  return (
    blob.v === 2 &&
    blob.alg === ENVELOPE_ALG &&
    typeof blob.iv === "string" &&
    typeof blob.ct === "string" &&
    blob.epk?.kty === "EC" &&
    blob.epk.crv === "P-256" &&
    typeof blob.epk.x === "string" &&
    typeof blob.epk.y === "string"
  );
}

/**
 * Human session only. The server cannot check what is inside (it never holds
 * either private key); the AAD binds the copy to this message and key, so a
 * copy made for another message will not open as this one.
 */
export async function storeBotCopy(store: MailStore, blobs: BlobStore, messageId: string, keyId: unknown, envelope: unknown): Promise<{ messageId: string; keyId: string }> {
  const key = activeBotKey(await store.getBotRegistry());
  if (!key) throw new MailError("Register a bot envelope key first", "invalid");
  if (keyId !== key.keyId) throw new MailError(`keyId must be the current bot key ${key.keyId}`, "conflict");
  if (!isEnvelope(envelope)) throw new MailError("envelope must be a lojo envelope (v 2)", "invalid");
  const encoded = encodeEnvelope({ v: 2, alg: ENVELOPE_ALG, epk: { kty: "EC", crv: "P-256", x: envelope.epk.x, y: envelope.epk.y }, iv: envelope.iv, ct: envelope.ct });
  if (encoded.byteLength > MAX_COPY_BYTES) throw new MailError("The bot copy is too large", "too_large");
  const message = await store.getMessage(messageId);
  if (!message) throw new MailError(`No message ${messageId}`, "not_found");
  const blobKey = botCopyKey(message.id, key.keyId);
  await blobs.put(blobKey, encoded, "application/json");
  await store.updateMessage(message.id, { botBodyKey: blobKey, botKeyId: key.keyId });
  return { messageId: message.id, keyId: key.keyId };
}
