import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const bundles = ["packages/pipeline/dist/processor.mjs", "packages/api/dist/api.mjs"];
let failed = false;
for (const path of bundles) {
  if (!existsSync(path)) {
    console.error(`${path}: missing. Run npm run build:lambda first.`);
    failed = true;
    continue;
  }
  try {
    const mod = await import(pathToFileURL(path).href);
    if (typeof mod.handler !== "function") throw new Error("export handler is not a function");
    console.log(`${path}: ok`);
  } catch (error) {
    console.error(`${path}: ${error instanceof Error ? error.stack : error}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
