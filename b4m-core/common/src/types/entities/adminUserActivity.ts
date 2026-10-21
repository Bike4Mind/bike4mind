import { z } from 'zod';
import type { AuditEntry } from './AdminAuditLogTypes';

/** `target`: entries done to this account. `actor`: entries this user performed. Never merged into one list. */
export const UserActivityDirectionSchema = z.enum(['target', 'actor']);
export type UserActivityDirection = z.infer<typeof UserActivityDirectionSchema>;

export type UserActivityPage = {
  entries: AuditEntry[];
  nextCursor: string | null;
  /** True when the user is, or ever acted as, a platform or org admin; gates the `actor` direction in the UI. */
  actorViewAvailable: boolean;
};

export const USER_CREDIT_HISTORY_DAYS = 90;

/**
 * From this instant every admin credit change writes a ledger row, so a balance reconstructed from the
 * ledger is trustworthy after it. It is the end of the first production deploy that made the admin
 * ledger mandatory, rounded up so no Lambda still ran the old code. Null treats the whole window as
 * possibly incomplete.
 */
export const ADMIN_CREDIT_LEDGER_RELIABLE_FROM: string | null = '2026-10-21T08:17:00Z';

export type UserCreditBalancePoint = {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  /** Balance at the end of `day`. */
  balance: number;
};

export type UserCreditAdjustmentMarker = {
  transactionId: string;
  occurredAt: string;
  /** Signed delta. */
  credits: number;
  actorUserId?: string;
  actorName: string;
  reason?: string;
};

export type UserCreditHistory = {
  windowDays: number;
  currentBalance: number;
  points: UserCreditBalancePoint[];
  adjustments: UserCreditAdjustmentMarker[];
  /** True when more admin adjustments fall in the window than were returned. */
  adjustmentsTruncated: boolean;
  /**
   * ISO instant before which the reconstructed balance may be wrong (admin changes that skipped the
   * ledger). Null when the whole window is reliable.
   */
  unreliableBefore: string | null;
};
