import { z } from "zod";
import { BotConfigError } from "./config.ts";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** `--name value`, `--name=value`, or a bare `--name` (true). Everything else is positional. */
export function parseArgv(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { positionals, flags };
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unwrap(schema.unwrap() as z.ZodTypeAny);
  if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault() as z.ZodTypeAny);
  return schema;
}

function coerce(value: string | boolean, schema: z.ZodTypeAny | undefined): unknown {
  if (typeof value === "boolean") return value;
  const inner = schema ? unwrap(schema) : undefined;
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) return value;
  if (inner instanceof z.ZodArray && !value.trimStart().startsWith("[")) return value.split(",").map((item) => item.trim()).filter(Boolean);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Arguments for one operation: `--json '{...}'` as the base, then each `--field value`, typed by the operation's schema. */
export function opArgs(parsed: ParsedArgs, schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const json = parsed.flags.json;
  if (typeof json === "string") {
    const base = JSON.parse(json) as unknown;
    if (!base || typeof base !== "object" || Array.isArray(base)) throw new BotConfigError("--json must be a JSON object");
    Object.assign(out, base);
  }
  for (const [name, value] of Object.entries(parsed.flags)) {
    if (name === "json") continue;
    if (!(name in schema.shape)) throw new BotConfigError(`Unknown argument --${name}. Arguments: ${Object.keys(schema.shape).map((key) => `--${key}`).join(" ") || "none"}`);
    out[name] = coerce(value, schema.shape[name]);
  }
  return out;
}
