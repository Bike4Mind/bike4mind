import { Logger } from '@bike4mind/observability';
import { IUserRepository } from '@bike4mind/common';

interface UpdateLogoutTimeAdapters {
  db: {
    users: Pick<IUserRepository, 'findById' | 'update'>;
  };
  logger?: Logger;
}

/**
 * Stamps the logout time on the user's most recent login record, if it has not
 * already been set. Loads the user, mutates the in-memory record, then persists
 * ONLY `loginRecords` via a targeted `$set` - matching the original manager's
 * dirty-path `user.save()` so a concurrent write to other fields
 * (`lastActiveAt`/`isOnline`/...) between the read and write isn't clobbered.
 */
export const updateLogoutTime = async (userId: string, { db, logger }: UpdateLogoutTimeAdapters) => {
  const user = await db.users.findById(userId);

  if (user && user.loginRecords && user.loginRecords.length > 0) {
    const lastLoginRecord = user.loginRecords[user.loginRecords.length - 1];
    if (!lastLoginRecord.logoutTime) {
      logger?.log('Setting logout time for user:', user.username, 'at:', new Date());
      lastLoginRecord.logoutTime = new Date();
      await db.users.update({ id: user.id, loginRecords: user.loginRecords });
    }
  }
};
