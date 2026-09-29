import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const skipDir = new Set(["node_modules", "dist", ".git", ".terraform", "coverage", "data", "imports"]);
const patterns = [
  { name: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "PGP private key", re: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "hard-coded cloud secret", re: /(?:aws_secret_access_key|secret_access_key)\s*=\s*"(?!\$\{)[^"]+"/ },
];

const hits = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDir.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (entry.name === "check-no-secrets.mjs") continue;
    const info = await stat(path);
    if (info.size > 1_000_000) continue;
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    for (const pattern of patterns) {
      if (pattern.re.test(text)) hits.push(`${relative(root, path)}: ${pattern.name}`);
    }
  }
}

await walk(root);
if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log("no secret material matched");
