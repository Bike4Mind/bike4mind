import type { IRealtimeConnectionRepository, IUserApiKeyRepository, IUserRepository } from '@bike4mind/common';
import { entersBlockedState, type AccountStateFields } from './accountState';
import { endRealtimeConnections } from '../authSessionService/endRealtimeConnections';

export interface FlagDisputePendingAdapters {
  db: {
    users: Pick<IUserRepository, 'update'>;
    userApiKeys: Pick<IUserApiKeyRepository, 'deactivateAllByUserId'>;
    realtimeConnections: Pick<IRealtimeConnectionRepository, 'endConnections'>;
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
    await endRealtimeConnections({ userId: user.id }, { db });
  }
  await db.users.update({ id: user.id, disputePending: true });
  return { deactivatedKeys };
}
