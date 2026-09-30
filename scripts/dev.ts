import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "start", "-w", "@lojo/api"], { stdio: "inherit", env: process.env }),
];

if (process.env.LOJO_DEV_WEB !== "0" && existsSync("packages/web/package.json")) {
  children.push(spawn("npm", ["run", "dev", "-w", "@lojo/web"], { stdio: "inherit", env: process.env }));
}

function shutdown() {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise(() => {});
