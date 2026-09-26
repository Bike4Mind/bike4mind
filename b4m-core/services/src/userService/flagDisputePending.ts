import type { IUserApiKeyRepository, IUserRepository } from '@bike4mind/common';
import { entersBlockedState, type AccountStateFields } from './accountState';

export interface FlagDisputePendingAdapters {
  db: {
    users: Pick<IUserRepository, 'update'>;
    userApiKeys: Pick<IUserApiKeyRepository, 'deactivateAllByUserId'>;
  };
}

/**
 * Flag a user as dispute-pending and deactivate their API keys when that entry blocks the account.
 *
 * Deactivation runs BEFORE the flag write on purpose: if it throws, Stripe's retry still sees the
 * flag unset and re-runs the whole path. (The admin update uses the opposite order: it deactivates
 * only after the user write has succeeded.) Returns whether keys were deactivated so the caller's
 * alert can say so.
 */
export async function flagDisputePending(
  user: AccountStateFields & { id: string },
  { db }: FlagDisputePendingAdapters
): Promise<{ deactivatedKeys: boolean }> {
  const deactivatedKeys = entersBlockedState(user, { ...user, disputePending: true });
  if (deactivatedKeys) {
    await db.userApiKeys.deactivateAllByUserId(user.id);
  }
  await db.users.update({ id: user.id, disputePending: true });
  return { deactivatedKeys };
}
