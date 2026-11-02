/**
 * Self-service account deletion. A request marks the account (`IUser.deletionRequestedAt`) and the
 * account is hard-deleted once the grace period has passed (apps/workers/src/cron/accountDeletionSweep.ts).
 * Until then the owner can sign in and restore it (POST /api/users/me/restore-deletion).
 */
export const ACCOUNT_DELETION_GRACE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When an account whose deletion was requested at `requestedAt` becomes due for the hard delete. */
export function accountDeletionDueAt(requestedAt: Date | string): Date {
  return new Date(new Date(requestedAt).getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS);
}

/** The latest request time that is already past its grace period at `now`. */
export function accountDeletionCutoff(now: Date): Date {
  return new Date(now.getTime() - ACCOUNT_DELETION_GRACE_DAYS * DAY_MS);
}

/** `code` on the 409 a delete request gets while the caller still owns an organization with other members. */
export const ACCOUNT_DELETION_ORG_TRANSFER_REQUIRED = 'account_deletion_org_transfer_required';

/** Flag on the 403 the auth chain returns to a deletion-pending session outside its allowlist. */
export const ACCOUNT_DELETION_PENDING_FLAG = 'accountDeletionPending';
