import { z, type ZodSchema } from 'zod';
import type { SmallLLMService } from '@bike4mind/services/llm/SmallLLMService';

// Shared reflect step: deep agents (deepAgent/llmSteps.ts) extend this schema with
// their charter fields; Loops (workers agentExecutor.loopReflection.ts) use it as is.
// A change here must keep both suites green.

// `.catch` placeholders keep a reflection from failing on a malformed field
// (Mongo requires non-empty strings).
export const ReflectCoreOutputSchema = z.object({
  reflection: z.string().min(1).catch('(no reflection produced)'),
  nextIntendedAction: z.string().min(1).catch('(next action undecided)'),
});

export async function completeReflection<T>(
  llm: SmallLLMService,
  prompt: string,
  schema: ZodSchema<T>,
  { timeoutMs, maxTokens }: { timeoutMs: number; maxTokens: number }
): Promise<T> {
  const { data } = await llm.completeJSON(prompt, schema, {
    taskType: 'extraction',
    temperature: 0,
    timeoutMs,
    maxTokens,
  });
  return data;
}
