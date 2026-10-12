import { z } from 'zod';

/**
 * SQS message schema for LiveOps triage jobs. Produced by the scheduled dispatcher
 * (apps/workers/src/cron/liveopsTriageDispatcher.ts) and the manual trigger API
 * (pages/api/admin/liveops-triage-configs/[id]/trigger.ts); consumed by
 * apps/workers/src/cron/liveopsTriageWorker.ts.
 *
 * The worker drops any message that fails this schema, logging the error and
 * returning without retrying, so producers and these constraints must stay in sync.
 */
export const LiveOpsTriageJobMessageSchema = z.object({
  configId: z.string().min(1),
  configName: z.string().min(1),
  /** Timestamp when dispatched (idempotency key). */
  dispatchedAt: z.number(),
  source: z.enum(['cron', 'manual']),
  dryRun: z.boolean().optional(),
  /** Optional lookback window for manual runs (defaults to config.runIntervalHours). */
  lookbackHours: z.number().int().min(1).max(168).optional(),
});

export type LiveOpsTriageJobMessage = z.infer<typeof LiveOpsTriageJobMessageSchema>;
