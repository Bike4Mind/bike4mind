import type { ToolResultScore, ToolResultValidator } from '@bike4mind/llm-adapters';
import type { z } from 'zod';

// Scores a tool's `validateResult` hands the agent confidence gate (ReActAgent.scoreToolResult).
// Both sit below the gate threshold (0.6 in apps/workers agentExecutor) so a recognized useless
// result can pause a run; a validator returns `undefined` for anything it does not recognize.

/** The tool caught an upstream failure and returned it as a message instead of throwing. */
export const FAILED_RESULT_SCORE: ToolResultScore = { confidence: 0.1, source: 'deterministic' };

/** The call worked but found nothing (no search hits, an empty file). */
export const EMPTY_RESULT_SCORE: ToolResultScore = { confidence: 0.3, source: 'deterministic' };

/** Scores a JSON result that does not parse, or does not match `schema`, as a failure. */
export function createStructuredResultValidator(schema: z.ZodType): ToolResultValidator {
  return result => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      return FAILED_RESULT_SCORE;
    }
    return schema.safeParse(parsed).success ? undefined : FAILED_RESULT_SCORE;
  };
}
