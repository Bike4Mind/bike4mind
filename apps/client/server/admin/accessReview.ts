import {
  ACCESS_REVIEW_DORMANT_DAYS_MAX,
  ACCESS_REVIEW_DORMANT_DAYS_MIN,
  BadRequestError,
  ForbiddenError,
  formatAdminPermissionSource,
  isFullAdmin,
  type AccessReviewDecision,
  type AdminAccessReviewRecord,
  type AdminPermissionSource,
} from '@bike4mind/common';
import {
  ACCESS_REVIEW_DEFAULT_DORMANT_DAYS,
  isDormant,
  type AccessReviewAdmin,
  type AccessReviewRole,
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
  admins.map(admin => {
    const decision = record?.decisions.find(({ userId }) => userId === admin.userId) ?? null;
    return {
      ...admin,
      dormant: isDormant(admin.lastAdminActionAt, now, dormantDays),
      noMfa: !admin.mfaEnabled,
      // A listed admin holds access, so a revoke recorded earlier was undone by a re-grant: decide again.
      decision: decision?.decision === 'revoked' ? null : decision,
    };
  });

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
  // Appended, never reordered: spreadsheets built on earlier exports read columns by position.
  'directPermissions',
  'roles',
  'permissionSources',
] as const;

export const ACCESS_REVIEW_ROLE_CSV_COLUMNS = ['roleId', 'role', 'permissions', 'members'] as const;

const roleCell = (roles: readonly { id: string; name: string | null }[]) =>
  roles.map(role => role.name ?? `deleted-role:${role.id}`).join(';');

const permissionSourcesCell = (sources: AdminPermissionSource[]) =>
  sources.map(source => `${source.permission}=${formatAdminPermissionSource(source)}`).join(';');

const memberCell = (members: AccessReviewRole['members']) =>
  members.map(member => member.email || member.username || member.userId).join(';');

const iso = (value: Date | string | null | undefined) =>
  value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : value;

/**
 * One row per current admin, then one per decision whose admin no longer holds access (a revoked
 * account drops out of the admin list, so its row comes from the decision snapshot). When `roles`
 * is given, a blank row and a role section with each role's members follow.
 */
export function toAccessReviewCsvRows(
  quarter: string,
  rows: AccessReviewRow[],
  record: AdminAccessReviewRecord | null,
  roles: AccessReviewRole[] = []
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
      row.directPermissions.join(';'),
      roleCell(row.roles),
      permissionSourcesCell(row.permissionSources),
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
        '',
        roleCell(decision.roles ?? []),
        '',
      ]),
    ...(roles.length > 0
      ? [
          [],
          [...ACCESS_REVIEW_ROLE_CSV_COLUMNS],
          ...roles.map(role => [role.id, role.name, role.permissions.join(';'), memberCell(role.members)]),
        ]
      : []),
  ];
}
