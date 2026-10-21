import { DecisionsRequestSchema, DecisionTextPartSchema } from '@bike4mind/common';
import type { z } from 'zod';

// Provider tool schemas are advisory: reject route-only image inputs before the host can read a file.
export const DecisionToolRequestSchema = DecisionsRequestSchema.pick({
  input: true,
  questions: true,
  model: true,
}).extend({
  input: DecisionTextPartSchema.shape.text,
  model: DecisionsRequestSchema.shape.model.optional(),
});

export type DecisionToolRequest = z.infer<typeof DecisionToolRequestSchema>;
