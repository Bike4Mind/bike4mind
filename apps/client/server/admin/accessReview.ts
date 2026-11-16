import {
  ACCESS_REVIEW_DORMANT_DAYS_MAX,
  ACCESS_REVIEW_DORMANT_DAYS_MIN,
  BadRequestError,
  ForbiddenError,
  isFullAdmin,
  type AccessReviewDecision,
  type AdminAccessReviewRecord,
} from '@bike4mind/common';
import {
  ACCESS_REVIEW_DEFAULT_DORMANT_DAYS,
  isDormant,
  type AccessReviewAdmin,
} from '@bike4mind/server-utils/security/accessReview/accessReview';
import { z } from 'zod';

/** The access review routes are full-admin only: a delegate must never review their own peers' access. */
export function assertAccessReviewer(user: { isAdmin?: boolean } | null | undefined): void {
  if (!isFullAdmin(user)) throw new ForbiddenError('Only full administrators can run the access review');
}

const DormantDaysSchema = z.coerce
  .number()
  .int()
  .min(ACCESS_REVIEW_DORMANT_DAYS_MIN)
  .max(ACCESS_REVIEW_DORMANT_DAYS_MAX)
  .default(ACCESS_REVIEW_DEFAULT_DORMANT_DAYS);

export function parseDormantDays(value: unknown): number {
  const parsed = DormantDaysSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestError(
      `dormantDays must be a whole number from ${ACCESS_REVIEW_DORMANT_DAYS_MIN} to ${ACCESS_REVIEW_DORMANT_DAYS_MAX}`
    );
  }
  return parsed.data;
}

export type AccessReviewRow = AccessReviewAdmin & {
  dormant: boolean;
  noMfa: boolean;
  decision: AccessReviewDecision | null;
};

export const toAccessReviewRows = (
  admins: AccessReviewAdmin[],
  record: AdminAccessReviewRecord | null,
  now: Date,
  dormantDays: number
): AccessReviewRow[] =>
  admins.map(admin => ({
    ...admin,
    dormant: isDormant(admin.lastAdminActionAt, now, dormantDays),
    noMfa: !admin.mfaEnabled,
    decision: record?.decisions.find(({ userId }) => userId === admin.userId) ?? null,
  }));

// An explicit allow-list: the export never serializes an admin or user object wholesale.
export const ACCESS_REVIEW_CSV_COLUMNS = [
  'quarter',
  'userId',
  'email',
  'username',
  'fullAdmin',
  'permissions',
  'grantedBy',
  'grantedAt',
  'lastAdminActionAt',
  'lastSignInAt',
  'mfaEnabled',
  'dormant',
  'decision',
  'reviewerName',
  'reviewerUserId',
  'decidedAt',
  'reviewCompletedAt',
] as const;

const iso = (value: Date | string | null | undefined) =>
  value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : value;

/**
 * One row per current admin, then one per decision whose admin no longer holds access (a revoked
 * account drops out of the admin list, so its row comes from the decision snapshot).
 */
export function toAccessReviewCsvRows(
  quarter: string,
  rows: AccessReviewRow[],
  record: AdminAccessReviewRecord | null
): unknown[][] {
  const completedAt = iso(record?.completedAt);
  const decisionCells = (decision: AccessReviewDecision | null | undefined) => [
    decision?.decision ?? '',
    decision?.reviewer.name ?? '',
    decision?.reviewer.userId ?? '',
    iso(decision?.decidedAt),
    completedAt,
  ];
  const listed = new Set(rows.map(row => row.userId));
  return [
    [...ACCESS_REVIEW_CSV_COLUMNS],
    ...rows.map(row => [
      quarter,
      row.userId,
      row.email ?? '',
      row.username ?? '',
      row.fullAdmin,
      row.permissions.join(';'),
      row.grantedBy ? row.grantedBy.email || row.grantedBy.name : '',
      row.grantedAt ?? '',
      row.lastAdminActionAt ?? '',
      row.lastSignInAt ?? '',
      row.mfaEnabled,
      row.dormant,
      ...decisionCells(row.decision),
    ]),
    ...(record?.decisions ?? [])
      .filter(decision => !listed.has(decision.userId))
      .map(decision => [
        quarter,
        decision.userId,
        decision.email ?? '',
        '',
        decision.fullAdmin,
        decision.permissions.join(';'),
        '',
        '',
        '',
        '',
        '',
        '',
        ...decisionCells(decision),
      ]),
  ];
}
