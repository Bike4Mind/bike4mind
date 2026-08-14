import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// -- Data Lake Spend Notification ------------------------------------------------------------
//
// The notification model this codebase never had: one row per notice sent about a data
// lake's embedding spend, existing SOLELY to make the send atomic and idempotent (a unique
// compound index is the dedup mechanism, not app-level logic). Types live here rather than
// inline in the model because the caller (enforceEmbeddingSpendGate) lives in
// b4m-core/services, which cannot import @bike4mind/database - the same split
// DataLakeAccessGrantModel and LakeAccessEventModel use.

/**
 * Two axes, not one flat enum, mirroring the gate's actual throw/return sites:
 * - `stopped` - a human must change a lever (the switch is off, or a lever is set to 0).
 * - `throttled` - resolves on its own (a saturated rate window stayed full past the wait budget).
 * - `budget_exhausted` - a reserve-first budget denied the call (run/lake/period).
 * - `approaching_cap` - a granted call crossed the warn threshold of a budget that has not
 *   denied anything yet.
 */
export const DATA_LAKE_SPEND_NOTIFICATION_KINDS = [
  'stopped',
  'throttled',
  'budget_exhausted',
  'approaching_cap',
] as const;
export type DataLakeSpendNotificationKind = (typeof DATA_LAKE_SPEND_NOTIFICATION_KINDS)[number];

/** Which lever/meter the notification is about. */
export const DATA_LAKE_SPEND_NOTIFICATION_SCOPES = ['switch', 'rate', 'run', 'lake', 'period'] as const;
export type DataLakeSpendNotificationScope = (typeof DATA_LAKE_SPEND_NOTIFICATION_SCOPES)[number];

/** Fraction of budget (0..1) that triggers an `approaching_cap` notice. User-confirmed at the ticket gate. */
export const EMBEDDING_SPEND_NOTIFY_THRESHOLD_PCT = 0.8;

/** Retention for a claim row - well past the platform's max configurable period budget window
 * (720h / 30 days), so a dedup row can never be swept while its window is still open. */
export const DATA_LAKE_SPEND_NOTIFICATION_RETENTION_DAYS = 90;

/** Non-identifying facts about the meter state at send time, rendered into the email body. */
export interface DataLakeSpendNotificationDetail {
  reason?: string;
  spentMicroUsd?: number;
  budgetMicroUsd?: number;
  periodHours?: number;
  windowEndsAt?: Date;
  batchId?: string;
  retryable?: boolean;
}

export interface IDataLakeSpendNotification {
  dataLakeId: string;
  /** Denormalized from the lake at claim time - lets a spend view filter by org without a join. */
  organizationId?: string | null;
  kind: DataLakeSpendNotificationKind;
  scope: DataLakeSpendNotificationScope;
  /** The dedup key's third component - see spendNotificationKeys.ts for how each scope derives it. */
  periodKey: string;
  /** Set only for `approaching_cap`. */
  thresholdPct?: number;
  recipientUserIds: string[];
  recipientCount: number;
  deliveredCount: number;
  deliveryFailed: boolean;
  detail: DataLakeSpendNotificationDetail;
  /** The moment the claim was taken, not necessarily when mail delivery finished. */
  sentAt: Date;
  expiresAt: Date;
}

export type IDataLakeSpendNotificationDocument = IDataLakeSpendNotification & IMongoDocument;

export interface ClaimSpendNotificationInput {
  dataLakeId: string;
  organizationId?: string | null;
  kind: DataLakeSpendNotificationKind;
  scope: DataLakeSpendNotificationScope;
  periodKey: string;
  thresholdPct?: number;
  detail: DataLakeSpendNotificationDetail;
}

export interface IDataLakeSpendNotificationRepository extends IBaseRepository<IDataLakeSpendNotificationDocument> {
  /**
   * Atomically claim the (dataLakeId, kind, scope, periodKey) dedup slot. Returns
   * `claimed: true` + the new row's id only for the winner of a race; every other caller
   * (including one that loses to a concurrent insert) gets `claimed: false`. This is the ONLY
   * correctness mechanism for "notify once per period" - never a check-then-insert.
   */
  claimNotification(input: ClaimSpendNotificationInput): Promise<{ claimed: boolean; id?: string }>;
  /** Record delivery outcome against an already-claimed row. */
  markDelivered(
    id: string,
    result: { recipientUserIds: string[]; deliveredCount: number; deliveryFailed: boolean }
  ): Promise<void>;
  /**
   * Delete the lake-scope claim for a lake, so a subsequent admin reset re-arms just that
   * notice. Scoped deliberately: period/run/switch/rate claims for the same lake are untouched,
   * since those windows aren't affected by a lifetime-meter reset.
   */
  deleteForLake(dataLakeId: string, scope: DataLakeSpendNotificationScope): Promise<number>;
  /** Most recent notifications for a lake, newest first - for a future owner-facing history view. */
  listRecentForLake(dataLakeId: string, limit?: number): Promise<IDataLakeSpendNotificationDocument[]>;
}
