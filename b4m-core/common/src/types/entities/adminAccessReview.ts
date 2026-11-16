import { z } from 'zod';

/**
 * In-app quarterly access review: one record per quarter holding a keep/revoke decision per admin.
 * The report it is made from is built in packages/server-utils/src/security/accessReview.
 */

export const ACCESS_REVIEW_DORMANT_DAYS_MIN = 7;
export const ACCESS_REVIEW_DORMANT_DAYS_MAX = 365;

export const AccessReviewDecisionValueSchema = z.enum(['confirmed', 'revoked']);
export type AccessReviewDecisionValue = z.infer<typeof AccessReviewDecisionValueSchema>;

export type AccessReviewReviewer = { userId: string; name: string };

export type AccessReviewDecision = {
  userId: string;
  email: string | null;
  fullAdmin: boolean;
  /** The admin's access when the decision was made, so a revoked row still shows what was removed. */
  permissions: string[];
  decision: AccessReviewDecisionValue;
  reviewer: AccessReviewReviewer;
  decidedAt: Date;
  /** The audit entry of the revocation itself; absent on a confirm. */
  auditEntryId?: string;
};

export type AdminAccessReviewRecord = {
  id: string;
  /** `YYYY-Qn`, UTC. */
  quarter: string;
  dormantDays: number;
  startedAt: Date;
  startedBy: AccessReviewReviewer;
  decisions: AccessReviewDecision[];
  completedAt: Date | null;
  completedBy: AccessReviewReviewer | null;
};

// Lowercase only: ids are compared as strings, and an uppercase spelling would slip past an equality check.
export const AccessReviewDecisionSchema = z.object({
  userId: z.string().regex(/^[a-f0-9]{24}$/, 'Not a valid user id'),
  decision: AccessReviewDecisionValueSchema,
  dormantDays: z.number().int().min(ACCESS_REVIEW_DORMANT_DAYS_MIN).max(ACCESS_REVIEW_DORMANT_DAYS_MAX).optional(),
});
export type AccessReviewDecisionRequest = z.infer<typeof AccessReviewDecisionSchema>;

export interface IAdminAccessReviewRepository {
  findByQuarter(quarter: string): Promise<AdminAccessReviewRecord | null>;
  findLatestCompleted(): Promise<AdminAccessReviewRecord | null>;
  /**
   * Creates the quarter's record if it is missing. Call it outside a transaction: a racing insert
   * aborts a transaction, so the duplicate-key retry only works outside one.
   */
  ensureRecord(quarter: string, dormantDays: number, startedBy: AccessReviewReviewer): Promise<void>;
  /**
   * Creates the quarter's record on its first decision and replaces a different earlier decision
   * (a confirm becoming a revoke, or a confirm after access was re-granted). Repeating the same
   * decision, or the same revocation, is a no-op and returns `changed: false`. The caller decides
   * which transitions are allowed.
   */
  recordDecision(
    quarter: string,
    dormantDays: number,
    startedBy: AccessReviewReviewer,
    decision: AccessReviewDecision
  ): Promise<{ record: AdminAccessReviewRecord; changed: boolean }>;
  /** Stamps completion once; a second call leaves the first completion in place. Null when no record exists. */
  markCompleted(quarter: string, at: Date, by: AccessReviewReviewer): Promise<AdminAccessReviewRecord | null>;
}
