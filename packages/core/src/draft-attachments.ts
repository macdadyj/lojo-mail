import { draftAttachmentKey, type BlobStore } from "./blob/store.ts";
import { draftAttachmentContext, serverOpenBytes, serverSealBytes, type KeyWrapper } from "./crypto/server-seal.ts";
import { MailError } from "./errors.ts";
import { sha256 } from "./ids.ts";
import { cleanContentType } from "./mime/compose.ts";
import type { OutboundAttachment } from "./send.ts";
import type { DraftAttachment, ServerSealedBlob } from "./types.ts";

export interface DraftAttachmentLimits {
  /** The whole encoded message, the same limit as `client-send`, so Thunderbird and the app agree. */
  maxMessageBytes: number;
  maxFiles: number;
}

/** `maxMessageBytes` equals `DEFAULT_CLIENT_SEND_LIMITS.maxBytes` (client-send.ts imports this module, so it is not imported here). */
export const DRAFT_ATTACHMENT_LIMITS: DraftAttachmentLimits = {
  maxMessageBytes: 4_000_000,
  maxFiles: 10,
};

export interface NewDraftAttachment {
  filename: string;
  contentType: string;
  /** What the client says the bytes hash to; checked against `data`. */
  sha256: string;
  data: Uint8Array;
}

const MAX_FILENAME_CHARS = 120;
const MESSAGE_OVERHEAD = 2_048;
const PER_ATTACHMENT_OVERHEAD = 512;

/** The name a recipient sees: no path, no control characters or quotes, at most 120 characters. */
export function cleanAttachmentFilename(name: string): string {
  const last = name.split(/[/\\]/).filter(Boolean).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = last.replace(/[\u0000-\u001f\u007f-\u009f"]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
  return [...cleaned].slice(0, MAX_FILENAME_CHARS).join("");
}

/** Base64 in 76-character lines with CRLF. */
export function encodedSize(bytes: number): number {
  const base64 = Math.ceil(bytes / 3) * 4;
  return base64 + Math.ceil(base64 / 76) * 2;
}

/**
 * The encoded size of a message with this text and these files. The same arithmetic as the iOS
 * app's `AttachmentBudget`, so a file the app says fits is one the server accepts.
 */
export function estimatedMessageBytes(textBytes: number, attachmentSizes: number[]): number {
  return (
    MESSAGE_OVERHEAD +
    textBytes +
    Math.floor(textBytes / 10) +
    attachmentSizes.reduce((sum, size) => sum + encodedSize(size) + PER_ATTACHMENT_OVERHEAD, 0)
  );
}

export function assertFits(text: string, attachments: Pick<DraftAttachment, "size">[], limits: DraftAttachmentLimits): void {
  if (attachments.length > limits.maxFiles) {
    throw new MailError(`A draft can carry at most ${limits.maxFiles} files`, "invalid");
  }
  const estimate = estimatedMessageBytes(Buffer.byteLength(text, "utf8"), attachments.map((file) => file.size));
  if (estimate > limits.maxMessageBytes) {
    throw new MailError(
      `With this file the message would be about ${estimate} bytes encoded, over the ${limits.maxMessageBytes}-byte limit`,
      "too_large",
    );
  }
}

/** The reviewed list names files by SHA-256, in draft order. */
export function sameFiles(reviewed: string[], attachments: DraftAttachment[]): boolean {
  return reviewed.length === attachments.length && reviewed.every((hash, index) => hash.toLowerCase() === attachments[index]?.sha256);
}

export function approvalFiles(attachments: DraftAttachment[] | undefined): Pick<DraftAttachment, "sha256" | "filename" | "contentType">[] {
  return (attachments ?? []).map(({ sha256: hash, filename, contentType }) => ({ sha256: hash, filename, contentType }));
}

export async function sealDraftAttachment(
  deps: { blobs: BlobStore; keys: KeyWrapper },
  draftId: string,
  attachmentId: string,
  input: NewDraftAttachment,
): Promise<DraftAttachment> {
  const actual = sha256(input.data);
  if (actual !== input.sha256.toLowerCase()) throw new MailError("sha256 does not match the uploaded bytes", "invalid");
  const sealed = await serverSealBytes(input.data, draftAttachmentContext(draftId, attachmentId), deps.keys);
  await deps.blobs.put(draftAttachmentKey(draftId, attachmentId), new TextEncoder().encode(JSON.stringify(sealed)), "application/json");
  return {
    id: attachmentId,
    filename: cleanAttachmentFilename(input.filename),
    contentType: cleanContentType(input.contentType),
    size: input.data.byteLength,
    sha256: actual,
  };
}

/** Opens every file on the draft and checks each against the hash the approval covers. */
export async function openDraftAttachments(
  deps: { blobs: BlobStore; keys: KeyWrapper },
  draftId: string,
  attachments: DraftAttachment[] | undefined,
): Promise<OutboundAttachment[]> {
  return Promise.all(
    (attachments ?? []).map(async (file) => {
      const stored = await deps.blobs.get(draftAttachmentKey(draftId, file.id));
      if (!stored) throw new MailError(`The file ${file.filename} is missing from this draft. Remove it and approve again.`, "invalid");
      const sealed = JSON.parse(new TextDecoder().decode(stored)) as ServerSealedBlob;
      const data = await serverOpenBytes(sealed, draftAttachmentContext(draftId, file.id), deps.keys);
      if (sha256(data) !== file.sha256) throw new MailError(`The file ${file.filename} changed after it was attached`, "forbidden");
      return { filename: file.filename, contentType: file.contentType, data };
    }),
  );
}

/** Best effort: a leftover object is sealed and the bucket's lifecycle removes old versions. */
export async function deleteDraftAttachments(blobs: BlobStore, draftId: string, attachments: DraftAttachment[] | undefined): Promise<number> {
  let failed = 0;
  for (const file of attachments ?? []) {
    await blobs.delete(draftAttachmentKey(draftId, file.id)).catch(() => {
      failed += 1;
    });
  }
  return failed;
}
