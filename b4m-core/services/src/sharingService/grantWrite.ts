import type { IUserShare } from '@bike4mind/common';

/**
 * The field-scoped payload for a version-guarded grant write: `users` and the read-time `__v`, never
 * the whole doc. Grant writes pass `includeDeleted: true` so a revoke still lands on a doc
 * soft-deleted after its read (an undelete would otherwise bring the revoked grant back), and a
 * whole-doc payload carries `deletedAt: null`, which would resurrect that tombstone instead.
 */
export const grantWrite = <T extends { id: string; users: IUserShare[] }>(doc: T): Pick<T, 'id' | 'users'> => {
  const { __v } = doc as { __v?: unknown };
  return { id: doc.id, users: doc.users, ...(typeof __v === 'number' ? { __v } : {}) };
};
