import { mkdirSync, writeFileSync } from "node:fs";
import { generateIdentity } from "@lojo/core";

const outFlag = process.argv.indexOf("--out");
const out = outFlag >= 0 ? process.argv[outFlag + 1] : "keys";
if (!out) {
  console.error("usage: npm run keygen -- --out ./keys");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const keys = await generateIdentity();
writeFileSync(`${out}/envelope.public.jwk`, `${JSON.stringify(keys.publicJwk, null, 2)}\n`);
writeFileSync(`${out}/envelope.private.jwk`, `${JSON.stringify(keys.privateJwk, null, 2)}\n`, { mode: 0o600 });
console.log(`Public key: ${out}/envelope.public.jwk`);
console.log(`Private key: ${out}/envelope.private.jwk (mode 600). Do not commit it.`);
