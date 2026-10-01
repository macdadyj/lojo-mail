import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

/** Object storage for sealed bodies, attachments, and AI-context copies. S3 in AWS. */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** A short-lived URL for large downloads, when the backend supports it. */
  presignGet?(key: string, expiresSeconds: number): Promise<string>;
}

export function bodyKey(messageId: string): string {
  return `objects/${messageId}.bin`;
}

export function attachmentKey(messageId: string, attachmentId: string): string {
  return `objects/${messageId}/${attachmentId}.bin`;
}

/** A file on a draft, KMS-sealed under `draftAttachmentContext`. Deleted when the draft is sent or discarded. */
export function draftAttachmentKey(draftId: string, attachmentId: string): string {
  return `drafts/${draftId}/${attachmentId}.bin`;
}

export function aiContextKey(messageId: string): string {
  return `ai-context/${messageId}.bin`;
}

/** Jon's mail rules, KMS-sealed under `rulesContext()`. */
export const RULES_KEY = "rules/current.bin";

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(bytes));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const found = this.objects.get(key);
    return found ? new Uint8Array(found) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** Local dev and the JSON-file importer: one file per key under a directory. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const clean = normalize(key);
    if (clean.startsWith("..") || clean.startsWith(sep) || clean.includes(`${sep}..${sep}`)) {
      throw new Error(`Refusing blob key ${key}`);
    }
    return join(this.root, clean);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(readFileSync(this.path(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
  }
}
