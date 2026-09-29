import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateIdentity, loadConfig, MemoryStore } from "@lojo/core";
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

  const second = await importMailbox({ input: root, contactsPath: join(root, "contacts.vcf"), folderMap: map, deps });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 3);
  assert.equal((await store.listMessages({ limit: 20 })).length, 3);
  assert.equal((await store.listContacts()).length, 1);
});
