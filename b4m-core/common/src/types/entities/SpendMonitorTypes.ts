import { IBaseRepository } from './BaseTypes';

export const SPEND_ROLLUP_SCOPE_TYPES = ['platform', 'User', 'Organization', 'Agent', 'apiKey', 'model'] as const;
export type SpendRollupScopeType = (typeof SPEND_ROLLUP_SCOPE_TYPES)[number];

export const SPEND_BUCKET_MS = 5 * 60 * 1000;

/** scopeId is 'all' for the platform scope. */
export interface ISpendRollup {
  bucketStart: Date;
  scopeType: SpendRollupScopeType;
  scopeId: string;
  credits: number;
  costUsd: number;
  creditsCharged: number;
  requests: number;
}

export const SPEND_RULE_IDS = [
  'platform_spike',
  'platform_cost_spike',
  'account_spike',
  'account_ceiling',
  'apikey_spike',
  'apikey_ceiling',
] as const;
export type SpendRuleId = (typeof SPEND_RULE_IDS)[number];

export type SpendAlertStatus = 'open' | 'acknowledged' | 'resolved';
export type SpendAlertSeverity = 'warning' | 'critical';

export interface ISpendAlert {
  rule: SpendRuleId;
  scopeType: SpendRollupScopeType;
  scopeId: string;
  /** `${rule}:${scopeType}:${scopeId}` while not resolved; unset on resolve. */
  openKey?: string;
  status: SpendAlertStatus;
  severity: SpendAlertSeverity;
  openedAt: Date;
  peakValue: number;
  lastValue: number;
  lastNotifiedValue?: number;
  lastNotifiedAt?: Date;
  clearRuns: number;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  /** End of the newest window a run has applied to this incident; a retry of that window is a no-op. */
  lastEvaluatedWindowEnd?: Date;
  /** Snapshot rendered in Slack. */
  context: Record<string, unknown>;
}

export interface ISpendRollupRepository extends IBaseRepository<ISpendRollup> {
  /** Recompute every scope's totals for the bucket starting at `bucketStart`. Idempotent. */
  rollupBucket(bucketStart: Date): Promise<{ docs: number }>;
  /** Newest bucketStart that has a platform doc, or null when nothing has been rolled up. */
  latestBucketStart(): Promise<Date | null>;
  /** Totals per scopeId summed over buckets in [from, to). Each total's bucketStart is synthetic: it is `from`. */
  sumWindow(
    scopeType: SpendRollupScopeType,
    from: Date,
    to: Date,
    scopeIds?: string[]
  ): Promise<Map<string, ISpendRollup>>;
  /** Per-bucket docs per scopeId over [from, to), ascending by bucketStart. */
  windowSeries(
    scopeType: SpendRollupScopeType,
    scopeIds: string[],
    from: Date,
    to: Date
  ): Promise<Map<string, ISpendRollup[]>>;
}
/** A persisted alert as the repository returns it. */
export type SpendAlertRecord = ISpendAlert & { id: string };

export interface ISpendAlertRepository extends IBaseRepository<SpendAlertRecord> {
  /** Incidents still holding an openKey: status open or acknowledged. */
  findActive(): Promise<SpendAlertRecord[]>;
  /**
   * Applies one run's patch unless a run already evaluated `patch.lastEvaluatedWindowEnd` or a later
   * window. Returns false when nothing matched, meaning an overlapping or retried run got there first.
   */
  applyEvaluation(
    patch: Partial<ISpendAlert> & { id: string; lastEvaluatedWindowEnd: Date },
    options?: { unset?: (keyof ISpendAlert)[] }
  ): Promise<boolean>;
}

export function floorToBucket(date: Date): Date {
  return new Date(Math.floor(date.getTime() / SPEND_BUCKET_MS) * SPEND_BUCKET_MS);
}

export function spendAlertOpenKey(rule: SpendRuleId, scopeType: SpendRollupScopeType, scopeId: string): string {
  return `${rule}:${scopeType}:${scopeId}`;
}
