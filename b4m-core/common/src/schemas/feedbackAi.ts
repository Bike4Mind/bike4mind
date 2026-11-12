import { z } from 'zod';

export const FEEDBACK_AI_AREAS = [
  'chat',
  'models',
  'tools',
  'knowledge',
  'billing',
  'account',
  'help',
  'interface',
  'other',
] as const;
export const FEEDBACK_AI_SEVERITIES = ['cosmetic', 'minor', 'major', 'blocking'] as const;
export const FEEDBACK_AI_POLICY = 'feedback-v1';
export const FeedbackAiLabelsSchema = z
  .object({
    area: z.enum(FEEDBACK_AI_AREAS),
    severity: z.enum(FEEDBACK_AI_SEVERITIES),
    actionable: z.boolean(),
    needsReply: z.boolean(),
    duplicateId: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .nullable(),
  })
  .strict();
export type FeedbackAiLabels = z.infer<typeof FeedbackAiLabelsSchema>;

export const FeedbackAiDecisionSchema = z
  .object({
    suggestionId: z.string().regex(/^[a-f0-9]{24}$/),
    labels: FeedbackAiLabelsSchema,
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export type FeedbackAiView = {
  suggestion: {
    id: string;
    labels: FeedbackAiLabels;
    probability: number;
    model: string;
    createdAt: string;
    status: 'pending' | 'accepted' | 'overridden';
  } | null;
  labels: FeedbackAiLabels | null;
  similar: { id: string; similarity: number }[];
};
