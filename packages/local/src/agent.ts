import { toolDefinitions } from "@lojo/mcp/catalog";
import { SERVER_INSTRUCTIONS } from "@lojo/mcp/remote";
import { callTool, type ToolContext } from "@lojo/mcp/tools";
import type { ChatBackend, ChatMessage, ChatTool } from "./chat.ts";

export const AGENT_SYSTEM = `${SERVER_INSTRUCTIONS}
Use the tools to answer Jon's question about his mail. Call a tool when you need data; answer in plain text when you have enough.
Never say you sent an email: you cannot. If Jon asks for a reply, create a draft and submit it for approval.`;

export interface AgentStep {
  tool: string;
  arguments: unknown;
  ok: boolean;
}

export interface AgentResult {
  answer: string;
  steps: AgentStep[];
  stoppedEarly: boolean;
}

/**
 * The tool-calling loop for any local model. It offers only the tools the
 * token's scopes allow, runs every call through `callTool` (scope check, then
 * the REST API with the same token), and returns results wrapped as untrusted
 * content. There is no send tool to offer.
 */
export async function runAgent(opts: {
  backend: ChatBackend;
  ctx: ToolContext;
  question: string;
  maxSteps?: number;
  onStep?: (step: AgentStep) => void;
}): Promise<AgentResult> {
  const defs = toolDefinitions(opts.ctx.scopes);
  const allowed = new Set(defs.map((tool) => tool.name));
  const chatTools: ChatTool[] = defs.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: opts.question },
  ];
  const steps: AgentStep[] = [];
  const maxSteps = opts.maxSteps ?? 6;
  for (let round = 0; round < maxSteps; round += 1) {
    const turn = await opts.backend.chat(messages, chatTools);
    if (turn.toolCalls.length === 0) return { answer: turn.content.trim(), steps, stoppedEarly: false };
    messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      let content: string;
      let ok = false;
      if (!allowed.has(call.name)) {
        content = `Tool ${call.name} is not available. Available tools: ${[...allowed].join(", ")}.`;
      } else {
        try {
          content = await callTool(call.name, call.arguments, opts.ctx);
          ok = true;
        } catch (error) {
          content = `Tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const step = { tool: call.name, arguments: call.arguments, ok };
      steps.push(step);
      opts.onStep?.(step);
      messages.push({ role: "tool", content, toolCallId: call.id, name: call.name });
    }
  }
  return { answer: `Stopped after ${maxSteps} tool rounds without a final answer.`, steps, stoppedEarly: true };
}
