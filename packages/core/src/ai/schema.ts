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

export function parseAiResult(text: string): AiResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Model did not return JSON");
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  return aiResultSchema.parse(parsed);
}
