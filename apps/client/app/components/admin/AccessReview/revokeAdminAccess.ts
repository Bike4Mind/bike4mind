import { isAxiosError } from 'axios';
import { sortAdminPermissions, sortAdminRoleIds, type AdminUserPermissionsChange } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import type { AccessReviewDecisionResult, AccessReviewRow } from '@client/app/hooks/data/adminAccessReview';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { adminUpdateErrorMessage } from '../Users/Profile/actions/useAdminUserUpdate';

/**
 * A failure that may have followed a committed write: no response, or a server error. Step-up
 * cancellation happens before the write, so it is never uncertain.
 */
export const isUncertainFailure = (error: unknown): boolean =>
  !isStepUpCancelled(error) && (!isAxiosError(error) || !error.response || error.response.status >= 500);

/** The permissions PUT that clears every delegated permission and admin role; null when there is none to clear. */
export const permissionsRemoval = (admin: AccessReviewRow, reason: string): AdminUserPermissionsChange | null =>
  admin.directPermissions.length > 0 || admin.adminRoleIds.length > 0
    ? {
        // The permissions route compares the cleaned set and its schema rejects an id no longer listed.
        before: sortAdminPermissions(admin.directPermissions),
        adminPermissions: [],
        beforeAdminRoleIds: sortAdminRoleIds(admin.adminRoleIds),
        adminRoleIds: [],
        reason,
      }
    : null;

export type BulkRevokeState = 'revoked' | 'unrecorded' | 'failed' | 'skipped';
export type BulkRevokeOutcome = { userId: string; state: BulkRevokeState; message?: string };

const recordRevocation = (userId: string, dormantDays: number) =>
  api.post<AccessReviewDecisionResult>('/api/admin/access-review/decisions', {
    userId,
    decision: 'revoked',
    dormantDays,
  });

async function revokeOne(admin: AccessReviewRow, reason: string, dormantDays: number): Promise<BulkRevokeOutcome> {
  const { userId } = admin;
  try {
    // The same audited routes as a single revoke, so each admin gets its own audit entries naming the reviewer.
    if (admin.fullAdmin) await api.put(`/api/admin/users/${userId}/role`, { isAdmin: false, reason });
    const removal = permissionsRemoval(admin, reason);
    if (removal) await api.put(`/api/admin/users/${userId}/permissions`, removal);
  } catch (error) {
    if (isStepUpCancelled(error)) throw error;
    // A certain refusal (e.g. the last super admin) left access in place, so there is nothing to record.
    // An uncertain one may have committed; recording below is safe because the decisions route refuses
    // a revoke while any access remains.
    if (!isUncertainFailure(error)) {
      return { userId, state: 'failed', message: adminUpdateErrorMessage(error, 'Access was not removed.') };
    }
  }
  return recordOnly(userId, dormantDays);
}

async function recordOnly(userId: string, dormantDays: number): Promise<BulkRevokeOutcome> {
  try {
    await recordRevocation(userId, dormantDays);
    return { userId, state: 'revoked' };
  } catch (error) {
    return {
      userId,
      state: 'unrecorded',
      message: adminUpdateErrorMessage(error, 'The revocation was not recorded.'),
    };
  }
}

/**
 * Revokes each admin in turn: removes the access, then records the decision. With `previous`, a retry
 * keeps finished rows, records the ones left unrecorded and leaves refused ones alone. A cancelled
 * step-up stops the run and marks the rest skipped.
 */
export async function revokeAdmins(
  admins: readonly AccessReviewRow[],
  reason: string,
  dormantDays: number,
  previous?: ReadonlyMap<string, BulkRevokeOutcome>
): Promise<BulkRevokeOutcome[]> {
  const outcomes: BulkRevokeOutcome[] = [];
  let stopped = false;
  for (const admin of admins) {
    const before = previous?.get(admin.userId);
    if (stopped) {
      outcomes.push(before?.state === 'revoked' ? before : { userId: admin.userId, state: 'skipped' });
      continue;
    }
    if (before?.state === 'revoked' || before?.state === 'failed') {
      outcomes.push(before);
      continue;
    }
    try {
      outcomes.push(
        before?.state === 'unrecorded'
          ? await recordOnly(admin.userId, dormantDays)
          : await revokeOne(admin, reason, dormantDays)
      );
    } catch {
      stopped = true;
      outcomes.push({ userId: admin.userId, state: 'skipped' });
    }
  }
  return outcomes;
}
