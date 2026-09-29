import { sha256 } from "../ids.ts";
import { heuristicPhishing } from "../mime/phishing.ts";
import type { Address, AiPublic, SealedBody } from "../types.ts";
import { parseAiResult, type AiResult } from "./schema.ts";
import type { LlmClient } from "./types.ts";

const SYSTEM = `You triage one email for Jon Hebert. Respond with a single JSON object and no markdown.
Fields:
- summary: one or two sentences
- category: personal | transactional | newsletter | notification | phishing | other
- priority: now | today | later | noise
- actionItems: [{ "text", "deadline" }] where deadline is an ISO date or null. Only include real asks.
- labels: short suggested labels. Do not invent people.
- phishingScore: integer 0-100
- phishingReasons: short strings
- unsubscribe: { "detected": boolean, "url": string|null, "mailto": string|null }
- threadSummary: summary of this message in the context you were given
- draftReply: a reply in Jon's voice, or "" if no reply is appropriate
Do not invent facts that are not in the message. Do not mention that you are a model.`;

export interface AnalyzeInput {
  subject: string;
  from: Address;
  to: string;
  text: string;
  threadContext: string;
  styleGuide: string;
  maxBodyChars: number;
}

export interface AnalyzeOutput {
  result: AiResult;
  aiPublic: AiPublic;
  sensitive: NonNullable<SealedBody["ai"]>;
  inputTokens: number;
  outputTokens: number;
  promptSha256: string;
  embedding: number[] | null;
  embeddingTokens: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated]`;
}

export function buildPrompt(input: AnalyzeInput): { system: string; user: string } {
  const system = `${SYSTEM}\n\nJon's style guide:\n${input.styleGuide}`;
  const user = [
    `From: ${input.from.name ? `${input.from.name} ` : ""}<${input.from.email}>`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "",
    "Thread context:",
    input.threadContext || "(none)",
    "",
    "Message:",
    truncate(input.text, input.maxBodyChars),
  ].join("\n");
  return { system, user };
}

export async function analyzeMessage(llm: LlmClient, input: AnalyzeInput): Promise<AnalyzeOutput> {
  const prompt = buildPrompt(input);
  const completion = await llm.complete({ system: prompt.system, user: prompt.user, maxTokens: 800, temperature: 0.2 });
  const result = parseAiResult(completion.text);
  const heuristic = heuristicPhishing({
    from: input.from,
    subject: input.subject,
    text: input.text,
  });
  const phishingScore = Math.max(heuristic.score, Math.round(result.phishingScore));
  const phishingReasons = [...heuristic.reasons, ...result.phishingReasons];
  const aiPublic: AiPublic = {
    category: result.category,
    priority: result.priority,
    phishingScore,
    labels: result.labels,
    unsubscribeDetected: result.unsubscribe.detected,
    skipped: false,
  };
  const sensitive: NonNullable<SealedBody["ai"]> = {
    summary: result.summary,
    threadSummary: result.threadSummary,
    actionItems: result.actionItems,
    draftReply: result.draftReply,
    phishingReasons,
  };
  if (result.unsubscribe.url) sensitive.unsubscribeUrl = result.unsubscribe.url;
  if (result.unsubscribe.mailto) sensitive.unsubscribeMailto = result.unsubscribe.mailto;

  let embedding: number[] | null = null;
  let embeddingTokens = 0;
  if (llm.embed) {
    const embedded = await llm.embed(`${input.subject}\n${truncate(input.text, 2000)}`);
    embedding = embedded.vector;
    embeddingTokens = embedded.tokens;
  }

  return {
    result,
    aiPublic,
    sensitive,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens + embeddingTokens,
    promptSha256: sha256(`${prompt.system}\n${prompt.user}`),
    embedding,
    embeddingTokens,
  };
}

export function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
