import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  assignThreadIds,
  FOLDERS,
  ingestRaw,
  refreshThread,
  type Folder,
  type IngestDeps,
  type IngestOptions,
  type MailStore,
  type StoredMessage,
} from "@lojo/core";
import { parseContactsCsv, parseVcards } from "./contacts.ts";
import { readMbox } from "./mbox.ts";

export interface ImportReport {
  imported: number;
  skipped: number;
  contacts: number;
  errors: string[];
}

export interface ImportInput {
  input: string;
  contactsPath?: string;
  folderMap: Record<string, string>;
  deps: IngestDeps;
}

function isFolder(value: string): value is Folder {
  return (FOLDERS as readonly string[]).includes(value);
}

function walk(dir: string, out: Array<{ file: string; folder?: string }> = []): Array<{ file: string; folder?: string }> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (/\.(eml|mbox)$/i.test(entry)) out.push({ file: path, folder: basename(dir) });
  }
  return out;
}

/** An mbox file is named after its folder (`Archive.mbox`); an .eml takes its directory's name. */
function folderNameFor(file: string, directory: string | undefined): string | undefined {
  if (extname(file).toLowerCase() === ".mbox") return basename(file, extname(file));
  return directory;
}

/** Where an exported folder lands. Unknown custom folders become an archive label. */
export function placement(folderName: string | undefined, folderMap: Record<string, string>): Pick<IngestOptions, "folder" | "labels"> {
  if (!folderName || folderName === "." || folderName === "emails") return {};
  const mapped = folderMap[folderName] ?? folderMap[folderName.toLowerCase()];
  if (mapped && isFolder(mapped)) return { folder: mapped };
  return { folder: "archive", labels: [folderName.trim().toLowerCase()] };
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function withoutBom(raw: Buffer): Buffer {
  return raw.subarray(0, 3).equals(UTF8_BOM) ? raw.subarray(3) : raw;
}

/** Why a file is not a message, or null. Such files are reported, never stored as blank messages. */
function notMailReason(raw: Buffer): string | null {
  const text = raw.subarray(0, 64 * 1024).toString("latin1").replace(/^\s+/, "");
  if (text.length === 0) return "empty file";
  const headerEnd = text.search(/\r?\n\r?\n/);
  const headers = headerEnd < 0 ? text : text.slice(0, headerEnd);
  // eslint-disable-next-line no-control-regex -- control bytes in a header block mean this is not RFC 5322 text
  if (/[\u0000-\u0008\u000e-\u001f]/.test(headers)) return "binary file, not a message";
  if (!/^[\x21-\x39\x3b-\x7e]+:/.test(headers)) return "no mail headers";
  return null;
}

async function* messagesIn(file: string): AsyncGenerator<Buffer> {
  if (extname(file).toLowerCase() === ".mbox") {
    yield* readMbox(file);
    return;
  }
  yield readFileSync(file);
}

export async function importMailbox(options: ImportInput): Promise<ImportReport> {
  const report: ImportReport = { imported: 0, skipped: 0, contacts: 0, errors: [] };
  const files = statSync(options.input).isDirectory()
    ? walk(options.input)
    : [{ file: options.input, folder: undefined as string | undefined }];

  const imported: StoredMessage[] = [];
  for (const item of files) {
    const where = placement(folderNameFor(item.file, item.folder), options.folderMap);
    for await (const exported of messagesIn(item.file)) {
      const raw = withoutBom(exported);
      const reason = notMailReason(raw);
      if (reason) {
        report.errors.push(`${item.file}: ${reason}`);
        continue;
      }
      try {
        const result = await ingestRaw(raw, options.deps, { origin: "import", ...where });
        if (result.duplicate) {
          report.skipped += 1;
          continue;
        }
        imported.push(result.message);
        report.imported += 1;
      } catch (error) {
        report.errors.push(`${item.file}: ${error instanceof Error ? error.message : "import failed"}`);
      }
    }
  }

  await relinkThreads(options.deps.store, imported);

  if (options.contactsPath) {
    const raw = readFileSync(options.contactsPath, "utf8");
    const contacts = options.contactsPath.toLowerCase().endsWith(".csv") ? parseContactsCsv(raw) : parseVcards(raw);
    for (const contact of contacts) {
      await options.deps.store.putContact(contact);
      report.contacts += 1;
    }
  }

  return report;
}

/** Exports are not in date order, so a reply can arrive before its parent. Re-thread what this run added. */
async function relinkThreads(store: MailStore, imported: StoredMessage[]): Promise<void> {
  if (imported.length === 0) return;
  const assigned = assignThreadIds(
    imported.map((message) => ({ rfcMessageId: message.rfcMessageId, references: message.references, inReplyTo: message.inReplyTo })),
  );
  const touched = new Map<string, string>();
  for (const message of imported) {
    const threadId = assigned.get(message.rfcMessageId);
    touched.set(message.threadId, message.subject);
    if (threadId && threadId !== message.threadId) {
      await store.updateMessage(message.id, { threadId });
      touched.set(threadId, message.subject);
    }
  }
  for (const [threadId, subject] of touched) await refreshThread(store, threadId, subject);
}

export function loadFolderMap(raw: string): Record<string, string> {
  return JSON.parse(raw) as Record<string, string>;
}
