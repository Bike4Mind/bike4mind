import { IUserDocument, OVERWATCH_SYSTEM_USER_EMAIL } from '@bike4mind/common';

interface GetSystemUserAdapters {
  db: {
    users: {
      findByEmail: (email: string) => Promise<IUserDocument | null>;
      findOrCreateByEmail: (email: string, defaults: Partial<IUserDocument>) => Promise<IUserDocument>;
      findById: (id: string) => Promise<IUserDocument | null>;
    };
  };
}

// Module-level in-process cache: avoids DB round-trip on every ingest key mint
let cachedSystemUserId: string | null = null;

export const getOrCreateOverwatchSystemUser = async (adapters: GetSystemUserAdapters): Promise<IUserDocument> => {
  const { db } = adapters;

  // Self-heal: evict cache if findById returns null (user was deleted)
  if (cachedSystemUserId) {
    const cached = await db.users.findById(cachedSystemUserId);
    if (cached) return cached;
    cachedSystemUserId = null;
  }

  // Atomic upsert - safe under concurrent first-mint race (E11000 handled in adapter)
  const user = await db.users.findOrCreateByEmail(OVERWATCH_SYSTEM_USER_EMAIL, {
    name: 'Overwatch System',
    username: 'overwatch-system',
    isSystem: true,
    isAdmin: false,
    email: OVERWATCH_SYSTEM_USER_EMAIL,
  });

  cachedSystemUserId = user.id;
  return user;
};

/** Exported for test isolation - reset the in-process cache between tests */
export const _resetSystemUserCache = () => {
  cachedSystemUserId = null;
};
