import type {
  AccessReviewReport,
  AccessReviewRow,
  WireAccessReviewDecision,
} from '@client/app/hooks/data/adminAccessReview';

export type ReviewStatus = 'pending' | 'confirmed' | 'revoked';
export type ReviewStatusFilter = ReviewStatus | 'all';

/** A live admin row, or an account whose access this review already revoked. */
export type ReviewRow = {
  live: AccessReviewRow | null;
  revoked: WireAccessReviewDecision | null;
  userId: string;
  status: ReviewStatus;
  reviewComplete: boolean;
};

const STATUS_ORDER: Record<ReviewStatus, number> = { pending: 0, confirmed: 1, revoked: 2 };

/**
 * A live admin is pending until confirmed this quarter. A live admin whose earlier revoke was undone by a
 * re-grant is pending again, matching the decisions route.
 */
const liveStatus = (admin: AccessReviewRow): ReviewStatus =>
  admin.decision?.decision === 'confirmed' ? 'confirmed' : 'pending';

export const rowLabel = (row: ReviewRow) =>
  row.live ? (row.live.email ?? row.live.username ?? row.userId) : (row.revoked?.email ?? row.userId);

/** Every live admin plus the accounts revoked this quarter, pending first, then confirmed, then revoked. */
export function buildReviewRows(data: Pick<AccessReviewReport, 'admins' | 'record'>): ReviewRow[] {
  const reviewComplete = Boolean(data.record?.completedAt);
  const live = data.admins.map<ReviewRow>(admin => ({
    live: admin,
    revoked: null,
    userId: admin.userId,
    status: liveStatus(admin),
    reviewComplete,
  }));
  const listed = new Set(data.admins.map(admin => admin.userId));
  const revoked = (data.record?.decisions ?? [])
    .filter(entry => entry.decision === 'revoked' && !listed.has(entry.userId))
    .map<ReviewRow>(entry => ({ live: null, revoked: entry, userId: entry.userId, status: 'revoked', reviewComplete }));
  // Array.prototype.sort is stable, so the server's order holds within a status.
  return [...live, ...revoked].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

export function countByStatus(rows: readonly ReviewRow[]): Record<ReviewStatusFilter, number> {
  const counts: Record<ReviewStatusFilter, number> = { all: rows.length, pending: 0, confirmed: 0, revoked: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export const filterByStatus = (rows: readonly ReviewRow[], filter: ReviewStatusFilter): ReviewRow[] =>
  filter === 'all' ? [...rows] : rows.filter(row => row.status === filter);

/**
 * Rule-based revoke hint: a full admin who is dormant and has no MFA is the highest-risk account on the
 * page. Only a pending row carries it; a confirmed admin was already kept on purpose.
 */
export const isSuggestedRevoke = (row: ReviewRow): boolean =>
  row.status === 'pending' && !!row.live && row.live.fullAdmin && row.live.dormant && row.live.noMfa;
