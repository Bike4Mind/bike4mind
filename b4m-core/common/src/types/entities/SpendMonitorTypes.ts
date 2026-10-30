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
  /** Snapshot rendered in Slack. */
  context: Record<string, unknown>;
}

// Placeholders: filled in by the rollup and alert repository tasks.
export interface ISpendRollupRepository {}
export interface ISpendAlertRepository {}

export function floorToBucket(date: Date): Date {
  return new Date(Math.floor(date.getTime() / SPEND_BUCKET_MS) * SPEND_BUCKET_MS);
}

export function spendAlertOpenKey(rule: SpendRuleId, scopeType: SpendRollupScopeType, scopeId: string): string {
  return `${rule}:${scopeType}:${scopeId}`;
}
