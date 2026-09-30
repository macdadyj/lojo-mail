import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const bundles = [
  { path: "packages/pipeline/dist/processor.mjs", exports: ["handler", "purge"] },
  { path: "packages/api/dist/api.mjs", exports: ["handler"] },
];
let failed = false;
for (const { path, exports } of bundles) {
  if (!existsSync(path)) {
    console.error(`${path}: missing. Run npm run build:lambda first.`);
    failed = true;
    continue;
  }
  try {
    const mod = await import(pathToFileURL(path).href);
    for (const name of exports) if (typeof mod[name] !== "function") throw new Error(`export ${name} is not a function`);
    console.log(`${path}: ok`);
  } catch (error) {
    console.error(`${path}: ${error instanceof Error ? error.stack : error}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
