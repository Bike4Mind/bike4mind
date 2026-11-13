import { getMemberCreditPeriodStart } from '../../memberCreditPeriod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// Org admin alerts: budget/balance thresholds, seat and member events, failed payments. Types live
// here rather than in the models because the evaluators in b4m-core/services cannot import
// @bike4mind/database (same split as DataLakeSpendNotificationTypes.ts).

export const ORG_ALERT_KINDS = [
  'budget_threshold',
  'low_balance',
  'member_cap',
  'payment_failed',
  'seat_limit',
  'member_joined',
] as const;
export type OrgAlertKind = (typeof ORG_ALERT_KINDS)[number];

export const ORG_ALERT_MAX_PERCENT_THRESHOLDS = 5;

/** Claim rows outlive the monthly period they dedupe, so a row is never swept while its period is open. */
export const ORG_ALERT_NOTIFICATION_RETENTION_DAYS = 90;

/** Owner-configured budget alerting, stored on the organization. */
export interface IOrgBudgetAlerts {
  enabled: boolean;
  /** Monthly pool budget the percent thresholds are measured against; null disables percent alerts. */
  monthlyBudgetCredits?: number | null;
  /** Integers in 1..100, deduplicated, at most ORG_ALERT_MAX_PERCENT_THRESHOLDS. */
  percentThresholds: number[];
  /** Alert when the pool balance falls to or below this many credits; null disables it. */
  lowBalanceCredits?: number | null;
}

export type OrgAlertKindPrefs = Partial<Record<OrgAlertKind, boolean>>;

/** One org admin's opt-in choices. A kind absent from `kinds` falls back to the role default. */
export interface IOrgAdminNotificationPref {
  organizationId: string;
  userId: string;
  kinds: OrgAlertKindPrefs;
}
export type IOrgAdminNotificationPrefDocument = IOrgAdminNotificationPref & IMongoDocument;

export interface IOrgAdminNotificationPrefRepository extends IBaseRepository<IOrgAdminNotificationPrefDocument> {
  getForOrg(organizationId: string): Promise<IOrgAdminNotificationPrefDocument[]>;
  getForUser(organizationId: string, userId: string): Promise<IOrgAdminNotificationPrefDocument | null>;
  /** Merges `kinds` into the user's row, creating it if missing. */
  upsertForUser(
    organizationId: string,
    userId: string,
    kinds: OrgAlertKindPrefs
  ): Promise<IOrgAdminNotificationPrefDocument | null>;
}

export type OrgAlertRecipientRole = 'owner' | 'manager';

/** Owners receive every kind unless they opt out; appointed managers receive nothing until they opt in. */
export function resolveOrgAlertOptIn(
  role: OrgAlertRecipientRole,
  row: Pick<IOrgAdminNotificationPref, 'kinds'> | null | undefined,
  kind: OrgAlertKind
): boolean {
  const explicit = row?.kinds?.[kind];
  if (typeof explicit === 'boolean') return explicit;
  return role === 'owner';
}

/** UTC 'YYYY-MM' of the period containing `now`, the same month boundary as the member credit cap. */
export function orgAlertPeriodKey(now: Date = new Date()): string {
  return getMemberCreditPeriodStart(now).toISOString().slice(0, 7);
}

/**
 * The dedup row for one alert. `scope` carries the threshold or subject (`pct:80`, `low:5000`,
 * `seats:10`, `user:<id>`) so editing a threshold mid-period can fire again.
 */
export interface IOrgAlertNotification {
  organizationId: string;
  kind: OrgAlertKind;
  scope: string;
  periodKey: string;
  /** Set when the alert is about one person, so account erasure can find and delete the row. */
  subjectUserId?: string | null;
  sentAt: Date;
  expiresAt: Date;
}
export type IOrgAlertNotificationDocument = IOrgAlertNotification & IMongoDocument;

export interface ClaimOrgAlertInput {
  organizationId: string;
  kind: OrgAlertKind;
  scope: string;
  periodKey: string;
  subjectUserId?: string | null;
}

export interface IOrgAlertNotificationRepository extends IBaseRepository<IOrgAlertNotificationDocument> {
  /**
   * Atomically claim the (organizationId, kind, scope, periodKey) slot. Only the winner of a race
   * gets `claimed: true`; the unique index is the whole dedup mechanism.
   */
  claim(input: ClaimOrgAlertInput): Promise<{ claimed: boolean; id?: string }>;
  /** Drop a claim whose delivery failed entirely, so a later event can retry it. */
  release(id: string): Promise<void>;
}
