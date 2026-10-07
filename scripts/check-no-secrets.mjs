import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skipDir = new Set(["node_modules", "dist", ".git", ".terraform", "coverage", "data", "imports", ".build"]);

export const patterns = [
  { name: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "PGP private key", re: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "hard-coded cloud secret", re: /(?:aws_secret_access_key|secret_access_key)\s*=\s*"(?!\$\{)[^"]+"/ },
  // The envelope private key. A P-256 `d` is 43 base64url characters.
  { name: "private JWK (d)", re: /["']?\bd["']?\s*:\s*["'][A-Za-z0-9_-]{40,}={0,2}["']/ },
];

export function scanText(text) {
  return patterns.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
}

async function walk(dir, hits) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDir.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, hits);
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
    for (const name of scanText(text)) hits.push(`${relative(root, path)}: ${name}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = [];
  await walk(root, hits);
  if (hits.length > 0) {
    console.error(hits.join("\n"));
    process.exit(1);
  }
  console.log("no secret material matched");
}
