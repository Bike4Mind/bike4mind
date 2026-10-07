/**
 * SQS message schema for LiveOps triage jobs. Produced by the scheduled dispatcher
 * (apps/workers/src/cron/liveopsTriageDispatcher.ts) and the manual trigger API
 * (pages/api/admin/liveops-triage-configs/[id]/trigger.ts); consumed by
 * apps/workers/src/cron/liveopsTriageWorker.ts.
 */
export interface LiveOpsTriageJobMessage {
  /** Config ID to process */
  configId: string;
  /** Config name (for logging) */
  configName: string;
  /** Timestamp when dispatched (for idempotency) */
  dispatchedAt: number;
  /** Source of the job */
  source: 'cron' | 'manual';
  /** If true, runs in dry-run mode */
  dryRun?: boolean;
  /** Optional lookback hours for manual runs (defaults to config.runIntervalHours) */
  lookbackHours?: number;
}
