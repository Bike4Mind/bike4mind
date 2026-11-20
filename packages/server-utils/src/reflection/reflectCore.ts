import { z, type ZodSchema } from 'zod';
import type { SmallLLMService } from '@bike4mind/services/llm/SmallLLMService';

// Shared reflect step: deep agents (deepAgent/llmSteps.ts) extend this schema with
// their charter fields; Loops (workers agentExecutor.loopReflection.ts) use it as is.
// A change here must keep both suites green.

// `.catch` placeholders keep a reflection from failing on a malformed field
// (Mongo requires non-empty strings).
export const NO_REFLECTION = '(no reflection produced)';
export const NO_NEXT_ACTION = '(next action undecided)';
export const ReflectCoreOutputSchema = z.object({
  reflection: z.string().min(1).catch(NO_REFLECTION),
  nextIntendedAction: z.string().min(1).catch(NO_NEXT_ACTION),
});

export async function completeReflection<T>(
  llm: SmallLLMService,
  prompt: string,
  schema: ZodSchema<T>,
  { timeoutMs, maxTokens, retries }: { timeoutMs: number; maxTokens: number; retries?: number }
): Promise<T> {
  const { data } = await llm.completeJSON(prompt, schema, {
    taskType: 'extraction',
    temperature: 0,
    timeoutMs,
    maxTokens,
    ...(retries !== undefined && { retries }),
  });
  return data;
}
