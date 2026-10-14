import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

// Shared by the tools that start a generation job (video_generation, music_generation).

// ToolContext carries no tool call id, so identical calls within one turn collapse to one job by design.
export const buildJobIdempotencyKey = (
  userId: string,
  questId: string | undefined,
  request: unknown
): string | undefined => {
  if (!questId) return undefined;
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 32);
  return `agent:${userId}:${questId}:${digest}`;
};

export const toToolParameters = (schema: z.ZodType): ICompletionOptionTools['toolSchema']['parameters'] => {
  const { $schema: _draft, ...jsonSchema } = z.toJSONSchema(schema);
  // Cast: the adapter type demands a description on every property, which optional enums lack.
  return jsonSchema as ICompletionOptionTools['toolSchema']['parameters'];
};

// Hosts that never wire a job tool config (and registry-wide builds) still construct every tool in b4mTools,
// so a missing config yields an inert tool instead of throwing and taking the whole turn down.
export const buildUnavailableTool = (name: string, label: string): ICompletionOptionTools => {
  const message = `${label} is not available in this context.`;
  return {
    toolFn: async () => message,
    toolSchema: { name, description: message, parameters: { type: 'object', properties: {} } },
  };
};
