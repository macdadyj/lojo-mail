import { z } from "zod";

export const aiResultSchema = z.object({
  summary: z.string(),
  category: z.enum(["personal", "transactional", "newsletter", "notification", "phishing", "other"]),
  priority: z.enum(["now", "today", "later", "noise"]),
  actionItems: z.array(z.object({ text: z.string(), deadline: z.string().nullable() })).default([]),
  labels: z.array(z.string()).default([]),
  phishingScore: z.number().min(0).max(100),
  phishingReasons: z.array(z.string()).default([]),
  unsubscribe: z
    .object({
      detected: z.boolean(),
      url: z.string().nullable().optional(),
      mailto: z.string().nullable().optional(),
    })
    .default({ detected: false }),
  threadSummary: z.string().default(""),
  draftReply: z.string().default(""),
});

export type AiResult = z.infer<typeof aiResultSchema>;

/** The model answered, but not with the JSON we asked for. The tokens were still spent. */
export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
  ) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export function parseAiResult(text: string): AiResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ModelOutputError("Model did not return JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ModelOutputError("Model returned malformed JSON");
  }
  const result = aiResultSchema.safeParse(parsed);
  if (!result.success) throw new ModelOutputError("Model JSON did not match the expected fields");
  return result.data;
}
