import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (entry.endsWith(".test.ts") || entry.endsWith(".test.mjs")) out.push(path);
  }
  return out;
}

const files = [...walk("packages"), ...walk("scripts"), ...walk("ios")];
if (files.length === 0) {
  console.error("no tests found");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
