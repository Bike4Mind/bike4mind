import { z } from 'zod';

export const MementoTypeEnum = z.enum(['prompt', 'reply', 'insight', 'context']);
export const MementoTierEnum = z.enum(['hot', 'warm', 'cold']);

export const CreateMementoSchema = z.object({
  type: MementoTypeEnum,
  tier: MementoTierEnum,
  weight: z.number().min(0).max(1000),
  summary: z.string().min(1),
  fullContent: z.string().prefault(''),
  sessionId: z.string().min(1, 'Session ID is required'),
  questId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  lastAccessedAt: z.preprocess(val => (val ? new Date(val as string) : new Date()), z.date()).optional(),
  isArchived: z.boolean().optional(),
});

export const UpdateMementoSchema = CreateMementoSchema.partial().omit({
  type: true, // type cannot be changed per business rules (optional, remove if allowed)
});

export type CreateMementoInput = z.infer<typeof CreateMementoSchema>;
export type UpdateMementoInput = z.infer<typeof UpdateMementoSchema>;
