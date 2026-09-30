import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { allowedTools, describeTool, effectiveScopes } from "./catalog.ts";
import { HttpMailClient } from "./http.ts";
import { SERVER_INSTRUCTIONS } from "./remote.ts";
import { parseScopes } from "./scopes.ts";
import { callTool } from "./tools.ts";

const baseUrl = process.env.LOJO_API_URL ?? "http://127.0.0.1:8787";
const token = process.env.LOJO_API_TOKEN ?? "dev-read-only";
const declared = parseScopes(process.env.LOJO_API_SCOPES ?? "read");
const mailbox = new HttpMailClient(baseUrl, token);

let scopes = declared;
try {
  scopes = effectiveScopes(declared, (await mailbox.session()).scopes);
} catch (error) {
  // stdout is the MCP channel, so diagnostics go to stderr.
  console.error(`lojo-mail MCP: could not confirm token scopes (${error instanceof Error ? error.message : String(error)}); using LOJO_API_SCOPES=${declared.join(",")}`);
}

const server = new McpServer({ name: "lojo-mail", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
for (const tool of allowedTools(scopes)) {
  server.registerTool(
    tool.name,
    { description: describeTool(tool), inputSchema: tool.schema, annotations: tool.annotations },
    async (args: unknown) => {
      try {
        const text = await callTool(tool.name, args, { mailbox, scopes });
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "tool failed";
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
