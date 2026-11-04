import { z } from 'zod';
import type { AuditEntry } from './AdminAuditLogTypes';

/**
 * Sign-off on critical audit entries. Reviews live in their own collection because the audit log is
 * append-only: nothing may stamp an entry as reviewed. One review per entry; a second admin's sign-off
 * is the point, so an admin can never review an entry they performed.
 */

export const AUDIT_REVIEW_BATCH_MAX = 100;
export const AUDIT_REVIEW_NOTE_MAX = 500;
/** On rollout, critical entries older than this are baselined as reviewed so the queue starts small. */
export const AUDIT_REVIEW_BASELINE_DAYS = 7;

// Lowercase only: ids are compared as strings, and an uppercase spelling would slip past an equality check.
const AuditEntryIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'Not a valid audit entry id');

/** `userId` is null only for the rollout baseline, which no admin performed. */
export type AuditReviewer = { userId: string | null; name: string };

export type AuditReview = {
  auditEntryId: string;
  reviewer: AuditReviewer;
  reviewedAt: Date;
  note?: string;
  baseline?: boolean;
};

export type NewAuditReview = Omit<AuditReview, 'reviewedAt'>;

/**
 * `unreviewed`: every critical entry with no review that the viewer did not perform and is not about, any age.
 * `all`: every critical entry since `from`, reviewed or not, the viewer's own included.
 */
export const AuditReviewQueueStatusSchema = z.enum(['unreviewed', 'all']);
export type AuditReviewQueueStatus = z.infer<typeof AuditReviewQueueStatusSchema>;

export type AuditReviewQueueEntry = AuditEntry & { review: AuditReview | null };

/** GET /api/admin/audit-log/review-queue. `total` counts every matching entry, not just this page. */
export type AuditReviewQueuePage = {
  entries: AuditReviewQueueEntry[];
  nextCursor: string | null;
  total: number;
};

/** GET /api/admin/audit-log/reviews?entryId= */
export type AuditReviewLookup = { review: AuditReview | null };

export const MarkAuditReviewedRequestSchema = z.object({
  entryIds: z.array(AuditEntryIdSchema).min(1).max(AUDIT_REVIEW_BATCH_MAX),
  note: z.string().trim().max(AUDIT_REVIEW_NOTE_MAX).optional(),
});
export type MarkAuditReviewedRequest = z.infer<typeof MarkAuditReviewedRequestSchema>;

/** Why an admin may not sign off an entry: they performed it, or it is about their own account. */
export type AuditReviewConflict = 'own_action' | 'about_you';

/** Returns why `userId` may not review `entry`, or null when they may. Ids compare case-insensitively. */
export const auditReviewConflict = (
  entry: Pick<AuditEntry, 'actor' | 'target'>,
  userId: string
): AuditReviewConflict | null => {
  const same = (id: string | null | undefined) => !!id && id.toLowerCase() === userId.toLowerCase();
  if (same(entry.actor.userId)) return 'own_action';
  if (entry.target.kind === 'user' && same(entry.target.id)) return 'about_you';
  return null;
};

export type MarkAuditReviewedSkipReason = 'not_found' | 'not_critical' | AuditReviewConflict | 'already_reviewed';

/** POST /api/admin/audit-log/reviews */
export type MarkAuditReviewedResult = {
  reviewed: string[];
  skipped: Array<{ id: string; reason: MarkAuditReviewedSkipReason }>;
};

export const UnmarkAuditReviewedRequestSchema = z.object({
  entryIds: z.array(AuditEntryIdSchema).min(1).max(AUDIT_REVIEW_BATCH_MAX),
});
export type UnmarkAuditReviewedRequest = z.infer<typeof UnmarkAuditReviewedRequestSchema>;

/** DELETE /api/admin/audit-log/reviews. Only the admin who signed off may take it back. */
export type UnmarkAuditReviewedResult = {
  unreviewed: string[];
  skipped: Array<{ id: string; reason: 'not_reviewed' | 'not_reviewer' }>;
};

export type AuditReviewQueueQuery = {
  status: AuditReviewQueueStatus;
  /** Required for `all`; ignored for `unreviewed`. */
  from?: Date;
  /** The viewer; `unreviewed` leaves out entries they performed or that target their account. */
  viewerUserId: string;
};

export interface IAdminAuditReviewRepository {
  /** Inserts the reviews, skipping entries that already have one. Returns the entry ids it inserted. */
  createMany(reviews: NewAuditReview[]): Promise<string[]>;
  findByEntryIds(entryIds: string[]): Promise<AuditReview[]>;
  /** Deletes only reviews `reviewerUserId` wrote. Returns the entry ids it deleted. */
  deleteByReviewer(entryIds: string[], reviewerUserId: string): Promise<string[]>;
}

/** The review queue reads the log joined to its reviews; kept beside the log's own read methods. */
export type ListAuditReviewQueue = (
  query: AuditReviewQueueQuery,
  page: { limit: number; cursor?: { occurredAt: Date; id: string } }
) => Promise<{
  entries: AuditReviewQueueEntry[];
  nextCursor: { occurredAt: Date; id: string } | null;
  total: number;
}>;
