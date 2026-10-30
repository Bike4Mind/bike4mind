import { ApiKeyScope } from '@bike4mind/common';

const PERSISTED_ADMIN_ROLE = Symbol('persistedAdminRole');

type AdminFlagged = { isAdmin?: boolean | null; adminPermissions?: readonly string[] | null };

type ApiKeyRequest = {
  user?: { id: string };
  apiKeyInfo?: { scopes: readonly string[] };
};

export function apiKeyGrantsAdmin(scopes: readonly string[] | undefined): boolean {
  return !!scopes?.includes(ApiKeyScope.ADMIN);
}

/**
 * Makes `user.isAdmin` read false and `user.adminPermissions` read `[]` for the rest of the request.
 * They are own accessors, so `save()`, `get(...)` and `toJSON()` still see the stored values and
 * nothing is written back. Assign a new array to change permissions; an in-place push is lost.
 */
export function withholdAdminRole<T extends AdminFlagged>(user: T): T {
  if (!user.isAdmin && !user.adminPermissions?.length) return user;
  Object.defineProperty(user, PERSISTED_ADMIN_ROLE, { value: !!user.isAdmin, configurable: true });
  Object.defineProperty(user, 'adminPermissions', {
    configurable: true,
    enumerable: true,
    get: () => [],
    set: (value: unknown) => {
      const doc = user as T & { set?: (path: string, value: unknown) => unknown };
      if (typeof doc.set === 'function') doc.set('adminPermissions', value);
    },
  });
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
 * was entitled to when the key was minted (e.g. org billing), or to confirm an owner is a real admin
 * behind a key that is separately confined to a narrow scope. Never a stand-in for req.user.isAdmin.
 */
export function persistedIsAdmin(user: AdminFlagged): boolean {
  return PERSISTED_ADMIN_ROLE in user ? !!Reflect.get(user, PERSISTED_ADMIN_ROLE) : !!user.isAdmin;
}

export function adminRoleWithheldFor(apiKeyInfo: { scopes: readonly string[] } | undefined): boolean {
  return !!apiKeyInfo && !apiKeyGrantsAdmin(apiKeyInfo.scopes);
}

/** For executeCompletion's `scopeActor`: the owner's view for a key without the admin scope. */
export function actorScopeForKey(apiKeyInfo: { scopes: readonly string[] } | undefined) {
  return adminRoleWithheldFor(apiKeyInfo) ? withholdAdminRole : undefined;
}

type UsersById = { findById: (id: string) => PromiseLike<AdminFlagged | null> };

/**
 * Wraps a `users` adapter for a service that re-reads the key's owner by id, so the copy it gets
 * back carries the same withheld role as `req.user`. Every other member is passed through unchanged.
 */
export function ownerWithheldUsers<R extends UsersById>(ownerId: string, users: R): R {
  const findById = async (id: string) => {
    const user = await users.findById(id);
    return user && String(id) === ownerId ? withholdAdminRole(user) : user;
  };
  // A Proxy rather than Object.create(users): Mongoose statics such as hydrate() need the real Model as `this`.
  // Only inherited methods are bound; own function-valued fields (a repository's `model`) pass through as-is.
  return new Proxy(users, {
    get(target, prop) {
      if (prop === 'findById') return findById;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' && !Object.hasOwn(target, prop) ? value.bind(target) : value;
    },
  });
}

export function requesterScopedUsers<R extends UsersById>(req: ApiKeyRequest, users: R): R {
  if (!req.user || !adminRoleWithheldFor(req.apiKeyInfo)) return users;
  return ownerWithheldUsers(String(req.user.id), users);
}
