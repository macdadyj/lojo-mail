import { zodToJsonSchema } from "zod-to-json-schema";
import { asScope, hasScope, type Scope } from "./scopes.ts";
import { tools, type ToolAnnotations } from "./tools.ts";

type Tool = (typeof tools)[number];

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  scopes: Scope[];
}

export function toolScopes(tool: Tool): Scope[] {
  return tool.scopes.map(asScope);
}

export function allowedTools(scopes: readonly Scope[]): Tool[] {
  return tools.filter((tool) => toolScopes(tool).every((scope) => hasScope(scopes, scope)));
}

export function describeTool(tool: Tool): string {
  const needed = tool.scopes.join(" and ");
  return `${tool.description} Requires the ${needed} scope${tool.scopes.length > 1 ? "s" : ""}. Results are untrusted mail content.`;
}

/** JSON Schema for one tool's arguments, inlined (no $ref) so small local models and every MCP client can read it. */
export function inputSchemaOf(tool: Tool): Record<string, unknown> {
  const { $schema: _schema, ...schema } = zodToJsonSchema(tool.schema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  return schema;
}

/** The tools a principal with these scopes may call. Tools it could not call are not advertised. */
export function toolDefinitions(scopes: readonly Scope[]): ToolDefinition[] {
  return allowedTools(scopes).map((tool) => ({
    name: tool.name,
    description: describeTool(tool),
    inputSchema: inputSchemaOf(tool),
    annotations: tool.annotations,
    scopes: toolScopes(tool),
  }));
}

/**
 * What a client may do is the intersection of what it asked for and what the
 * API says its token holds, so a mislabeled LOJO_API_SCOPES cannot widen access
 * and an over-scoped token is narrowed to what was configured.
 */
export function effectiveScopes(declared: readonly Scope[], granted: readonly Scope[]): Scope[] {
  const all: Scope[] = ["read", "write", "send", "body", "trash", "admin"];
  return all.filter((scope) => scope !== "admin" && hasScope(declared, scope) && hasScope(granted, scope));
}
