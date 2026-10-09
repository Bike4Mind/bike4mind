import { z } from 'zod';

export const LiveOpsTriageJobMessageSchema = z.object({
  configId: z.string().min(1),
  configName: z.string().min(1),
  dispatchedAt: z.number(),
  source: z.enum(['cron', 'manual']),
  dryRun: z.boolean().optional(),
  lookbackHours: z.number().int().min(1).max(168).optional(),
});

export type LiveOpsTriageJobMessage = z.infer<typeof LiveOpsTriageJobMessageSchema>;
