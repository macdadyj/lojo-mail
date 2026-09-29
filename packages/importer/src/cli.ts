import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { generateIdentity, loadConfig, MemoryStore, MockLlm, type EcPublicJwk, type EcPrivateJwk } from "@lojo/core";
import { importMailbox, loadFolderMap } from "./import-mailbox.ts";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    contacts: { type: "string" },
    map: { type: "string", default: "config/tuta-folder-map.json" },
    store: { type: "string", default: "data/mailbox.json" },
    analyze: { type: "boolean", default: false },
    "public-key": { type: "string" },
  },
});

if (!values.input) {
  console.error("usage: npm run import -- --input imports/tuta [--contacts contacts.vcf] [--store data/mailbox.json]");
  process.exit(2);
}

const config = loadConfig();
const storePath = values.store ?? "data/mailbox.json";
mkdirSync(dirname(storePath), { recursive: true });
const store = existsSync(storePath) ? MemoryStore.fromSnapshot(JSON.parse(readFileSync(storePath, "utf8"))) : new MemoryStore();
const publicPath = values["public-key"] ?? `${storePath}.public.jwk`;
const privatePath = publicPath.replace(/public\.jwk$/, "private.jwk");
let publicJwk: EcPublicJwk;
if (existsSync(publicPath)) {
  publicJwk = JSON.parse(readFileSync(publicPath, "utf8")) as EcPublicJwk;
} else {
  const generated = await generateIdentity();
  publicJwk = generated.publicJwk;
  writeFileSync(publicPath, `${JSON.stringify(generated.publicJwk, null, 2)}\n`);
  writeFileSync(privatePath, `${JSON.stringify(generated.privateJwk satisfies EcPrivateJwk, null, 2)}\n`, { mode: 0o600 });
  console.error(`Generated an envelope keypair at ${publicPath}. Keep the private file out of git.`);
}

const folderMap = existsSync(values.map ?? "") ? loadFolderMap(readFileSync(values.map ?? "", "utf8")) : {};
const report = await importMailbox({
  input: values.input,
  contactsPath: values.contacts,
  folderMap,
  deps: {
    store,
    publicJwk,
    llm: values.analyze ? new MockLlm() : null,
    config,
    styleGuide: existsSync("config/style-guide.md") ? readFileSync("config/style-guide.md", "utf8") : "",
  },
});
writeFileSync(storePath, `${JSON.stringify(store.snapshot(), null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.errors.length > 0) process.exit(1);
