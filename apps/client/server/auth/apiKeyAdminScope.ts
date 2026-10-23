import { ApiKeyScope } from '@bike4mind/common';

const PERSISTED_ADMIN_ROLE = Symbol('persistedAdminRole');

type AdminFlagged = { isAdmin?: boolean };

type ApiKeyRequest = {
  user?: { id: string };
  apiKeyInfo?: { scopes: readonly string[] };
};

export function apiKeyGrantsAdmin(scopes: readonly string[] | undefined): boolean {
  return !!scopes?.includes(ApiKeyScope.ADMIN);
}

/**
 * Makes `user.isAdmin` read false for the rest of the request. It is an own accessor, so `save()`,
 * `get('isAdmin')` and `toJSON()` still see the stored role and nothing is written back.
 */
export function withholdAdminRole<T extends AdminFlagged>(user: T): T {
  if (!user.isAdmin) return user;
  Object.defineProperty(user, PERSISTED_ADMIN_ROLE, { value: true, configurable: true });
  Object.defineProperty(user, 'isAdmin', {
    configurable: true,
    enumerable: true,
    get: () => false,
    set: (value: unknown) => {
      const doc = user as T & { set?: (path: string, value: unknown) => unknown };
      if (typeof doc.set === 'function') doc.set('isAdmin', value);
    },
  });
  return user;
}

/**
 * The user's stored role, ignoring withholdAdminRole. Only for checks about what the key's owner
 * was entitled to when the key was minted (e.g. org billing), never for granting admin authority.
 */
export function persistedIsAdmin(user: AdminFlagged): boolean {
  return PERSISTED_ADMIN_ROLE in user || !!user.isAdmin;
}

/**
 * Wraps a `users` adapter for a service that re-reads the caller by id, so the copy it gets back
 * carries the same withheld role as `req.user`. Every other method is inherited unchanged.
 */
export function requesterScopedUsers<R extends { findById: (id: string) => PromiseLike<AdminFlagged | null> }>(
  req: ApiKeyRequest,
  users: R
): R {
  if (!req.apiKeyInfo || apiKeyGrantsAdmin(req.apiKeyInfo.scopes) || !req.user) return users;
  const requesterId = String(req.user.id);
  const scoped: R = Object.create(users);
  scoped.findById = async (id: string) => {
    const user = await users.findById(id);
    return user && String(id) === requesterId ? withholdAdminRole(user) : user;
  };
  return scoped;
}
