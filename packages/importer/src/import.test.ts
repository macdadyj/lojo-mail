import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateIdentity, loadConfig, MemoryBlobStore, MemoryStore } from "@lojo/core";
import { parseContactsCsv, parseVcards } from "./contacts.ts";
import { importMailbox } from "./import-mailbox.ts";
import { splitMbox } from "./mbox.ts";

const parent = `From: Mina Cho <mina@example.com>
To: lojo@cyberphysical.us
Subject: Parent
Date: Mon, 01 Sep 2026 12:00:00 +0000
Message-ID: <parent-1@example.com>
Content-Type: text/plain; charset=utf-8

The first note.
`;

const child = `From: Mina Cho <mina@example.com>
To: lojo@cyberphysical.us
Subject: Re: Parent
Date: Tue, 02 Sep 2026 12:00:00 +0000
Message-ID: <child-1@example.com>
In-Reply-To: <mid-1@example.com>
References: <mid-1@example.com>
Content-Type: text/plain; charset=utf-8

Follow up.
`;

const middle = `From: Mina Cho <mina@example.com>
To: lojo@cyberphysical.us
Subject: Re: Parent
Date: Tue, 02 Sep 2026 08:00:00 +0000
Message-ID: <mid-1@example.com>
In-Reply-To: <parent-1@example.com>
References: <parent-1@example.com>
Content-Type: text/plain; charset=utf-8

Middle.
`;

test("mbox split and contact parsers", () => {
  const mbox = `From user@host Mon Sep 1 00:00:00 2026\n${parent}\nFrom user@host Tue Sep 2 00:00:00 2026\n${middle}`;
  assert.equal(splitMbox(mbox).length, 2);
  const cards = parseVcards("BEGIN:VCARD\nFN:Ada Lovelace\nEMAIL:ada@example.com\nEND:VCARD\n");
  assert.equal(cards[0]?.email, "ada@example.com");
  assert.equal(cards[0]?.name, "Ada Lovelace");
  const csv = parseContactsCsv("email,name\nmina@example.com,Mina Cho\n");
  assert.equal(csv[0]?.name, "Mina Cho");
});

test("import is idempotent, maps folders, and relinks threads", async () => {
  const root = mkdtempSync(join(tmpdir(), "lojo-import-"));
  mkdirSync(join(root, "Inbox"));
  mkdirSync(join(root, "Projects"));
  writeFileSync(join(root, "Inbox", "child.eml"), child);
  writeFileSync(join(root, "Projects", "parent.eml"), parent);
  writeFileSync(join(root, "Inbox", "middle.eml"), middle);
  writeFileSync(join(root, "contacts.vcf"), "BEGIN:VCARD\nFN:Ada Lovelace\nEMAIL:ada@example.com\nEND:VCARD\n");
  const { publicJwk } = await generateIdentity();
  const store = new MemoryStore();
  const deps = {
    store,
    blobs: new MemoryBlobStore(),
    publicJwk,
    llm: null,
    config: loadConfig({ LOJO_LLM_PROVIDER: "mock" }),
    styleGuide: "",
  };
  const map = { Inbox: "inbox", Projects: "archive" };
  const first = await importMailbox({ input: root, contactsPath: join(root, "contacts.vcf"), folderMap: map, deps });
  assert.equal(first.imported, 3);
  assert.equal(first.skipped, 0);
  assert.equal(first.contacts, 1);
  const messages = await store.listMessages({ limit: 20 });
  const parentMsg = messages.find((message) => message.rfcMessageId === "parent-1@example.com");
  const childMsg = messages.find((message) => message.rfcMessageId === "child-1@example.com");
  assert.equal(parentMsg?.folder, "archive");
  assert.ok(parentMsg?.labels.includes("projects") || parentMsg?.folder === "archive");
  assert.equal(childMsg?.folder, "inbox");
  assert.equal(parentMsg?.threadId, childMsg?.threadId);
  assert.equal((await store.listThreads()).length, 1, "the thread emptied by relinking is retired");
  assert.equal(childMsg?.unread, false);
  assert.equal(childMsg?.origin, "import");

  const second = await importMailbox({ input: root, contactsPath: join(root, "contacts.vcf"), folderMap: map, deps });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 3);
  assert.equal((await store.listMessages({ limit: 20 })).length, 3);
  assert.equal((await store.listContacts()).length, 1);
});

async function importDeps() {
  const { publicJwk } = await generateIdentity();
  const store = new MemoryStore();
  return { store, blobs: new MemoryBlobStore(), publicJwk, llm: null, config: loadConfig({ LOJO_LLM_PROVIDER: "mock" }), styleGuide: "" };
}

test("a final re-export with CRLF line endings and extra blank lines is skipped, not re-imported", async () => {
  const deps = await importDeps();
  const first = mkdtempSync(join(tmpdir(), "lojo-import-lf-"));
  mkdirSync(join(first, "Inbox"));
  writeFileSync(join(first, "Inbox", "parent.eml"), parent);
  writeFileSync(join(first, "Inbox", "latin1.eml"), Buffer.concat([Buffer.from(middle.replace("Middle.", "Caf")), Buffer.from([0xe9]), Buffer.from(".\n")]));
  assert.equal((await importMailbox({ input: first, folderMap: {}, deps })).imported, 2);

  const again = mkdtempSync(join(tmpdir(), "lojo-import-crlf-"));
  mkdirSync(join(again, "Inbox"));
  writeFileSync(join(again, "Inbox", "parent.eml"), `${parent.replace(/\n/g, "\r\n")}\r\n\r\n`);
  writeFileSync(
    join(again, "Inbox", "latin1.eml"),
    Buffer.concat([Buffer.from(middle.replace("Middle.", "Caf").replace(/\n/g, "\r\n")), Buffer.from([0xe9]), Buffer.from(".\r\n")]),
  );
  const report = await importMailbox({ input: again, folderMap: {}, deps });
  assert.deepEqual({ imported: report.imported, skipped: report.skipped, errors: report.errors }, { imported: 0, skipped: 2, errors: [] });
  assert.equal((await deps.store.listMessages({ limit: 20 })).length, 2);
});

test("empty, binary, and header-less .eml files are import errors, not blank messages", async () => {
  const deps = await importDeps();
  const root = mkdtempSync(join(tmpdir(), "lojo-import-bad-"));
  mkdirSync(join(root, "Inbox"));
  writeFileSync(join(root, "Inbox", "empty.eml"), "");
  writeFileSync(join(root, "Inbox", "blank.eml"), "\r\n  \n");
  writeFileSync(join(root, "Inbox", "image.eml"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  writeFileSync(join(root, "Inbox", "nul-header.eml"), Buffer.concat([Buffer.from("From: a@example.com\nSubject: x"), Buffer.from([0x00]), Buffer.from("\n\nbody\n")]));
  writeFileSync(join(root, "Inbox", "notes.eml"), "Just some notes I saved with the wrong extension.\n");
  writeFileSync(join(root, "Inbox", "bom.eml"), `\ufeff${parent}`);
  const report = await importMailbox({ input: root, folderMap: {}, deps });
  assert.equal(report.imported, 1, "the BOM-prefixed message still imports");
  const reasons = Object.fromEntries(report.errors.map((line) => [line.split("/").pop()?.split(":")[0], line.split(": ").pop()]));
  assert.deepEqual(reasons, {
    "blank.eml": "empty file",
    "empty.eml": "empty file",
    "image.eml": "binary file, not a message",
    "notes.eml": "no mail headers",
    "nul-header.eml": "binary file, not a message",
  });
  const stored = await deps.store.listMessages({ limit: 20 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.subject, "Parent");
  assert.equal(stored[0]?.from.email, "mina@example.com");
});
