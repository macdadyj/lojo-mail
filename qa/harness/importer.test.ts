// Importer QA with a synthetic Tuta-style export. Fixtures are generated into a
// temp directory so no large file is committed.
//
//   node --import tsx --test qa/harness/importer.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { b64ToBytes, generateIdentity, loadConfig, MemoryStore, openJson, type SealedBody } from "@lojo/core";
import { importMailbox, loadFolderMap } from "../../packages/importer/src/import-mailbox.ts";

const repo = new URL("../../", import.meta.url).pathname;
const folderMap = loadFolderMap(readFileSync(join(repo, "config/tuta-folder-map.json"), "utf8"));

const header = (o: { from: string; subject: string; id?: string; date: string; extra?: string[] }) =>
  [
    `From: ${o.from}`,
    "To: Jon Hebert <lojo@tuta.io>",
    `Subject: ${o.subject}`,
    `Date: ${o.date}`,
    ...(o.id ? [`Message-ID: <${o.id}>`] : []),
    "MIME-Version: 1.0",
    ...(o.extra ?? []),
  ].join("\r\n");

const LARGE_BYTES = 20 * 1024 * 1024;
const large = Buffer.alloc(LARGE_BYTES);
for (let i = 0; i < large.length; i += 1) large[i] = (i * 31 + 7) & 0xff;
const largeSha = createHash("sha256").update(large).digest("hex");

function buildExport(root: string): void {
  for (const dir of ["Inbox", "Sent", "Archive", "Projects", "mbox"]) mkdirSync(join(root, dir), { recursive: true });

  writeFileSync(
    join(root, "Inbox", "001-utf8.eml"),
    `${header({ from: "Mina Cho <mina@example.com>", subject: "=?UTF-8?Q?Caf=C3=A9_on_Friday_=E2=98=95?=", id: "utf8-1@example.com", date: "Mon, 01 Sep 2025 10:00:00 +0000", extra: ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"] })}\r\n\r\nSee you at the café. Grüße, 日本語テキスト.\r\n`,
  );

  // Latin-1 8-bit body: common in older mail and in Tuta exports of it.
  writeFileSync(
    join(root, "Inbox", "002-latin1-8bit.eml"),
    Buffer.concat([
      Buffer.from(`${header({ from: "=?ISO-8859-1?Q?Ren=E9_Dubois?= <rene@example.fr>", subject: "=?ISO-8859-1?Q?R=E9union_=E0_Z=FCrich?=", id: "latin1-1@example.fr", date: "Tue, 02 Sep 2025 10:00:00 +0200", extra: ["Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: 8bit"] })}\r\n\r\n`, "ascii"),
      Buffer.from("Le caf\xe9 est pr\xeat. \xc0 bient\xf4t.\r\n", "latin1"),
    ]),
  );

  writeFileSync(
    join(root, "Inbox", "003-iso2022jp.eml"),
    `${header({ from: "Kenji <kenji@example.jp>", subject: "=?ISO-2022-JP?B?GyRCRnxLXDhsGyhC?=", id: "jp-1@example.jp", date: "Wed, 03 Sep 2025 10:00:00 +0900", extra: ["Content-Type: text/plain; charset=iso-2022-jp", "Content-Transfer-Encoding: 7bit"] })}\r\n\r\n\x1b$BF|K\\8l\x1b(B\r\n`,
  );

  writeFileSync(
    join(root, "Inbox", "004-no-message-id.eml"),
    `${header({ from: "Printer <scanner@office.example>", subject: "Scan", date: "Thu, 04 Sep 2025 10:00:00 +0000", extra: ["Content-Type: text/plain"] })}\r\n\r\nNo Message-ID header on this one.\r\n`,
  );

  // Same message exported from two folders (Tuta keeps a copy per label).
  const dup = `${header({ from: "Noah Patel <noah@example.com>", subject: "Harbor notes", id: "dup-1@example.com", date: "Fri, 05 Sep 2025 10:00:00 +0000", extra: ["Content-Type: text/plain"] })}\r\n\r\nNotes attached later.\r\n`;
  writeFileSync(join(root, "Inbox", "005-dup.eml"), dup);
  writeFileSync(join(root, "Archive", "005-dup-copy.eml"), dup);

  writeFileSync(
    join(root, "Sent", "006-reply.eml"),
    `From: Jon Hebert <lojo@tuta.io>\r\nTo: Noah Patel <noah@example.com>\r\nSubject: Re: Harbor notes\r\nDate: Fri, 05 Sep 2025 12:00:00 +0000\r\nMessage-ID: <reply-1@tuta.io>\r\nIn-Reply-To: <dup-1@example.com>\r\nReferences: <dup-1@example.com>\r\nContent-Type: text/plain\r\n\r\nThanks.\r\n`,
  );

  writeFileSync(
    join(root, "Projects", "007-custom-folder.eml"),
    `${header({ from: "Sable <sable@example.com>", subject: "Sketch v2", id: "proj-1@example.com", date: "Sat, 06 Sep 2025 10:00:00 +0000", extra: ["Content-Type: text/plain"] })}\r\n\r\nFor the project folder.\r\n`,
  );

  const b64 = large.toString("base64").replace(/.{76}/g, "$&\r\n");
  writeFileSync(
    join(root, "Inbox", "008-large-attachment.eml"),
    `${header({ from: "Sable <sable@example.com>", subject: "Drawings (20 MB)", id: "large-1@example.com", date: "Sun, 07 Sep 2025 10:00:00 +0000", extra: ['Content-Type: multipart/mixed; boundary="b"'] })}\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nAttached.\r\n--b\r\nContent-Type: application/octet-stream; name="drawings.bin"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="drawings.bin"\r\n\r\n${b64}\r\n--b--\r\n`,
  );

  // mboxo-style export: one body line starts with "From " and is not escaped,
  // another is mboxrd-escaped as ">From ".
  writeFileSync(
    join(root, "mbox", "Archive.mbox"),
    [
      "From mina@example.com Mon Sep  8 10:00:00 2025",
      header({ from: "Mina Cho <mina@example.com>", subject: "mbox one", id: "mbox-1@example.com", date: "Mon, 08 Sep 2025 10:00:00 +0000", extra: ["Content-Type: text/plain"] }),
      "",
      "First paragraph.",
      "From the desk of Mina: this line is part of the body.",
      "Last paragraph of mbox one.",
      "",
      "From noah@example.com Tue Sep  9 10:00:00 2025",
      header({ from: "Noah Patel <noah@example.com>", subject: "mbox two", id: "mbox-2@example.com", date: "Tue, 09 Sep 2025 10:00:00 +0000", extra: ["Content-Type: text/plain"] }),
      "",
      ">From here the quoted line was escaped by the exporter.",
      "",
    ].join("\n"),
  );
}

async function run(root: string, store: MemoryStore, publicJwk: Awaited<ReturnType<typeof generateIdentity>>["publicJwk"]) {
  return importMailbox({ input: root, folderMap, deps: { store, publicJwk, llm: null, config: loadConfig({ LOJO_LLM_PROVIDER: "mock", LOJO_LOCAL_PART: "lojo", LOJO_DOMAIN: "tuta.io" }), styleGuide: "" } });
}

const root = mkdtempSync(join(tmpdir(), "lojo-qa-tuta-"));
buildExport(root);
const { publicJwk, privateJwk } = await generateIdentity();
const store = new MemoryStore();
const first = await run(root, store, publicJwk);
const messages = await store.listMessages({ limit: 1000 });
const byId = (id: string) => messages.find((m) => m.rfcMessageId === id);
const open = async (id: string) => {
  const m = byId(id);
  assert.ok(m, `missing ${id}`);
  return openJson<SealedBody>(m.envelope, privateJwk);
};

test.after(() => rmSync(root, { recursive: true, force: true }));

test("[report] first run", () => {
  console.log(JSON.stringify({ first, stored: messages.length, rfcIds: messages.map((m) => m.rfcMessageId).sort() }, null, 1));
});

test("[control] cross-folder duplicate is stored once", () => {
  assert.equal(messages.filter((m) => m.rfcMessageId === "dup-1@example.com").length, 1);
});

test("[control] re-run is idempotent (no new messages, threads, or contacts)", async () => {
  const threadsBefore = (await store.listThreads()).length;
  const second = await run(root, store, publicJwk);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, first.imported + first.skipped);
  assert.equal((await store.listMessages({ limit: 1000 })).length, messages.length);
  assert.equal((await store.listThreads()).length, threadsBefore);
});

test("[control] UTF-8 8-bit body and RFC 2047 subject survive", async () => {
  assert.equal(byId("utf8-1@example.com")?.subject, "Café on Friday ☕");
  assert.match((await open("utf8-1@example.com")).text, /café\. Grüße, 日本語テキスト/);
});

test("[control] ISO-2022-JP subject/body decode", async () => {
  assert.equal(byId("jp-1@example.jp")?.subject, "日本語");
  assert.match((await open("jp-1@example.jp")).text, /日本語/);
});

test("[P1] Latin-1 8-bit body is corrupted (file read as UTF-8 string before parsing)", async () => {
  assert.equal(byId("latin1-1@example.fr")?.subject, "Réunion à Zürich", "encoded-word subject is fine");
  const text = (await open("latin1-1@example.fr")).text;
  assert.match(text, /Le café est prêt\. À bientôt\./, `body decoded as ${JSON.stringify(text)}`);
});

test("[control] message without Message-ID gets a stable synthetic key", () => {
  const scan = messages.find((m) => m.subject === "Scan");
  assert.match(scan?.rfcMessageId ?? "", /^generated\./);
});

test("[control] 20 MB attachment round-trips byte-for-byte through the envelope", async () => {
  const body = await open("large-1@example.com");
  const att = body.attachments[0];
  assert.ok(att);
  const bytes = b64ToBytes(att.bytesB64);
  assert.equal(bytes.byteLength, LARGE_BYTES);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), largeSha);
});

test("[P0 on AWS] the 20 MB message would not fit a DynamoDB item (envelope is stored inline)", () => {
  const item = Buffer.byteLength(JSON.stringify(byId("large-1@example.com")));
  assert.ok(item < 400 * 1024, `item is ${(item / 1024 / 1024).toFixed(1)} MB`);
});

test("[control] folders: Sent via From, custom folder becomes label + archive", () => {
  assert.equal(byId("reply-1@tuta.io")?.folder, "sent");
  const proj = byId("proj-1@example.com");
  assert.equal(proj?.folder, "archive");
  assert.ok(proj?.labels.includes("projects"));
  assert.equal(byId("reply-1@tuta.io")?.threadId, byId("dup-1@example.com")?.threadId);
});

test("[P2] imported history lands unread and floods triage", () => {
  const unread = messages.filter((m) => m.folder === "inbox" && m.unread).length;
  assert.equal(unread, 0, `${unread} historical inbox messages imported as unread`);
});

test("[P2] mbox: an unescaped body line starting with 'From ' truncates the message and drops text", async () => {
  const text = (await open("mbox-1@example.com")).text;
  assert.match(text, /From the desk of Mina/);
  assert.match(text, /Last paragraph of mbox one/);
});

test("[P2] mbox: '>From ' escaping (mboxrd) is not reversed", async () => {
  const text = (await open("mbox-2@example.com")).text;
  assert.doesNotMatch(text, /^>From /m);
});

test("[P1] CLI: re-run through `npm run import` reuses the JSON store and is idempotent; no path to DynamoDB", () => {
  const work = mkdtempSync(join(tmpdir(), "lojo-qa-cli-"));
  try {
    const small = join(work, "export");
    mkdirSync(join(small, "Inbox"), { recursive: true });
    writeFileSync(join(small, "Inbox", "a.eml"), readFileSync(join(root, "Inbox", "001-utf8.eml")));
    writeFileSync(join(small, "Inbox", "b.eml"), readFileSync(join(root, "Inbox", "005-dup.eml")));
    const store = join(work, "mailbox.json");
    const cli = () =>
      spawnSync(process.execPath, ["--import", "tsx", join(repo, "packages/importer/src/cli.ts"), "--input", small, "--store", store, "--map", join(repo, "config/tuta-folder-map.json")], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, LOJO_STORE: "dynamo", LOJO_LLM_PROVIDER: "mock" },
      });
    const a = cli();
    const b = cli();
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.match(a.stdout, /"imported": 2/);
    assert.match(b.stdout, /"imported": 0/);
    assert.match(b.stdout, /"skipped": 2/);
    const snapshot = readFileSync(store, "utf8");
    assert.ok(snapshot.length > 0, "wrote the local JSON store even though LOJO_STORE=dynamo was set");
    assert.fail("MIGRATION.md says LOJO_STORE=dynamo imports into AWS; the CLI ignores it and only writes the local JSON snapshot");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("[P2] CLI: --public-key path not ending in public.jwk gets the PRIVATE key written into it", () => {
  const work = mkdtempSync(join(tmpdir(), "lojo-qa-key-"));
  try {
    const small = join(work, "export");
    mkdirSync(join(small, "Inbox"), { recursive: true });
    writeFileSync(join(small, "Inbox", "a.eml"), readFileSync(join(root, "Inbox", "001-utf8.eml")));
    const keyPath = join(work, "envelope-pub.json");
    const r = spawnSync(process.execPath, ["--import", "tsx", join(repo, "packages/importer/src/cli.ts"), "--input", small, "--store", join(work, "m.json"), "--public-key", keyPath], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, LOJO_LLM_PROVIDER: "mock" },
    });
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(keyPath, "utf8")) as { d?: string };
    assert.equal(written.d, undefined, "the file named as the public key now contains the private scalar d");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
