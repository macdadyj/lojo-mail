import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpMailClient } from "./http.ts";
import { parseScopes } from "./scopes.ts";
import { callTool, tools } from "./tools.ts";

const baseUrl = process.env.LOJO_API_URL ?? "http://127.0.0.1:8787";
const token = process.env.LOJO_API_TOKEN ?? "dev-read-only";
const scopes = parseScopes(process.env.LOJO_API_SCOPES ?? "read");
const mailbox = new HttpMailClient(baseUrl, token);

const server = new McpServer({ name: "lojo-mail", version: "0.1.0" });
for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      description: `${tool.description} Requires the ${tool.scope} scope.`,
      inputSchema: tool.schema,
    },
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
