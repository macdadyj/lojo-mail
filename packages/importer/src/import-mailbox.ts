import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  assignThreadIds,
  FOLDERS,
  ingestRaw,
  type Folder,
  type IngestDeps,
  type MailStore,
  type StoredMessage,
} from "@lojo/core";
import { parseContactsCsv, parseVcards } from "./contacts.ts";
import { splitMbox } from "./mbox.ts";

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
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (/\.(eml|mbox)$/i.test(entry)) out.push({ file: path, folder: basename(dir) });
  }
  return out;
}

export async function importMailbox(options: ImportInput): Promise<ImportReport> {
  const report: ImportReport = { imported: 0, skipped: 0, contacts: 0, errors: [] };
  const stat = statSync(options.input);
  const files = stat.isDirectory()
    ? walk(options.input)
    : [{ file: options.input, folder: undefined as string | undefined }];

  for (const item of files) {
    const raw = readFileSync(item.file, "utf8");
    const chunks = extname(item.file).toLowerCase() === ".mbox" ? splitMbox(raw) : [raw];
    for (const chunk of chunks) {
      try {
        const result = await ingestRaw(chunk, { ...options.deps, llm: options.deps.llm });
        if (result.duplicate) {
          report.skipped += 1;
          continue;
        }
        await applyFolder(options.deps.store, result.message, item.folder, options.folderMap);
        report.imported += 1;
      } catch (error) {
        report.errors.push(`${item.file}: ${error instanceof Error ? error.message : "import failed"}`);
      }
    }
  }

  await relinkThreads(options.deps.store);

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

async function applyFolder(
  store: MailStore,
  message: StoredMessage,
  folderName: string | undefined,
  folderMap: Record<string, string>,
): Promise<void> {
  if (!folderName || folderName === "." || folderName === "emails") return;
  const mapped = folderMap[folderName] ?? folderMap[folderName.toLowerCase()];
  if (mapped && isFolder(mapped)) {
    await store.updateMessage(message.id, { folder: mapped });
    return;
  }
  const label = folderName.trim().toLowerCase();
  const labels = message.labels.includes(label) ? message.labels : [...message.labels, label];
  await store.updateMessage(message.id, { folder: "archive", labels });
}

async function relinkThreads(store: MailStore): Promise<void> {
  const messages = await store.listMessages({ limit: 10000 });
  const assigned = assignThreadIds(
    messages.map((message) => ({
      rfcMessageId: message.rfcMessageId,
      references: message.references,
      inReplyTo: message.inReplyTo,
    })),
  );
  for (const message of messages) {
    const threadId = assigned.get(message.rfcMessageId);
    if (threadId && threadId !== message.threadId) {
      await store.updateMessage(message.id, { threadId });
    }
  }
  const grouped = new Map<string, StoredMessage[]>();
  const refreshed = await store.listMessages({ limit: 10000 });
  for (const message of refreshed) {
    const list = grouped.get(message.threadId) ?? [];
    list.push(message);
    grouped.set(message.threadId, list);
  }
  for (const [threadId, group] of grouped) {
    const sorted = [...group].sort((a, b) => (a.date < b.date ? 1 : -1));
    const latest = sorted[0];
    if (!latest) continue;
    await store.putThread({
      id: threadId,
      subject: latest.subject,
      participants: [...new Set(group.flatMap((message) => [message.from.email, ...message.to.map((item) => item.email)]))],
      lastDate: latest.date,
      unreadCount: group.filter((message) => message.unread).length,
      messageIds: [...sorted].reverse().map((message) => message.id),
      folder: group.some((message) => message.folder === "inbox") ? "inbox" : latest.folder,
    });
  }
}

export function loadFolderMap(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as Record<string, string>;
  return parsed;
}
