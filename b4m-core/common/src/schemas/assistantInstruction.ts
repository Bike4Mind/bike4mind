import { z } from 'zod';

/**
 * Wire schemas for standing assistant instructions (`/api/v1/assistant/instructions`): short notes a
 * user keeps about what their briefs should highlight and how to word them. The brief composer
 * (apps/workers/src/events/briefCompose.ts) reads them as preferences; they never change a brief's shape
 * or add a decision.
 */

/** Bounds shared by the store, the route and the composer, which clips to them. */
export const ASSISTANT_INSTRUCTION_LIMITS = {
  text: 280,
  perUser: 20,
} as const;

export const AssistantInstructionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(ASSISTANT_INSTRUCTION_LIMITS.text),
  createdAt: z.string().describe('ISO 8601 timestamp.'),
});

export const CreateAssistantInstructionRequestSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(ASSISTANT_INSTRUCTION_LIMITS.text)
    .describe('The instruction, trimmed. Whitespace-only text is rejected.'),
});

export const AssistantInstructionListResponseSchema = z.object({
  instructions: z.array(AssistantInstructionSchema).describe('Oldest first.'),
});

export const AssistantInstructionIdParamSchema = z.object({
  id: z.string().min(1).describe('The instruction id.'),
});

export type AssistantInstruction = z.infer<typeof AssistantInstructionSchema>;
export type CreateAssistantInstructionRequest = z.infer<typeof CreateAssistantInstructionRequestSchema>;
