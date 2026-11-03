import { ACCOUNT_DELETION_PENDING_CODE, ForbiddenError, type IUserDeletion } from '@bike4mind/common';

/** Minimal shape the gate reads off a user. */
export interface DeletionGateUser {
  id: string;
  deletion?: Pick<IUserDeletion, 'scheduledFor'> | null;
}

export const isAccountDeletionPending = (user: Pick<DeletionGateUser, 'deletion'> | null | undefined): boolean =>
  !!user?.deletion?.scheduledFor;

/**
 * What a deletion-pending session may still reach: the cancel screen's reads, the cancel itself, and
 * sign-out. Exact (path, method) pairs; every other route answers 403 ACCOUNT_DELETION_PENDING.
 */
const DELETION_PENDING_ALLOWLIST: ReadonlyArray<{ path: string; methods: readonly string[] }> = [
  { path: '/api/account/deletion', methods: ['GET', 'DELETE'] },
  { path: '/api/identify', methods: ['GET'] },
  { path: '/api/logout', methods: ['GET'] },
];

/** True when this request must be refused because the account is in its deletion grace period. */
export function isBlockedByPendingDeletion(user: DeletionGateUser | undefined, url: string, method: string): boolean {
  if (!user || !isAccountDeletionPending(user)) return false;
  const path = url.split('?')[0];
  // auth/success bootstraps the signed-in user from its own profile.
  if (method === 'GET' && path === `/api/users/${user.id}`) return false;
  return !DELETION_PENDING_ALLOWLIST.some(entry => entry.path === path && entry.methods.includes(method));
}

export const ACCOUNT_DELETION_PENDING_MESSAGE =
  'This account is scheduled for deletion. Cancel the deletion to use it again.';

export const accountDeletionPendingError = (deletion: Pick<IUserDeletion, 'scheduledFor'>) =>
  new ForbiddenError(ACCOUNT_DELETION_PENDING_MESSAGE, {
    code: ACCOUNT_DELETION_PENDING_CODE,
    scheduledFor: new Date(deletion.scheduledFor).toISOString(),
  });

/**
 * For the surfaces outside baseApi that authenticate a user themselves (CLI/completion JWT verifier,
 * WebSocket connect, token minting): a deletion-pending account may use none of them.
 */
export function assertNoPendingDeletion(user: Pick<DeletionGateUser, 'deletion'>): void {
  if (user.deletion?.scheduledFor) throw accountDeletionPendingError(user.deletion);
}
