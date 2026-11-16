import { ApiKeyScope, attachOrgApiKeyReach, orgApiKeyReachOf } from '@bike4mind/common';

const PERSISTED_ADMIN_ROLE = Symbol('persistedAdminRole');

type AdminFlagged = {
  isAdmin?: boolean | null;
  adminPermissions?: readonly string[] | null;
  roleAdminPermissions?: readonly string[] | null;
  adminRoleIds?: readonly unknown[] | null;
};

type ApiKeyRequest = {
  user?: { id: string };
  apiKeyInfo?: { scopes: readonly string[] };
};

export function apiKeyGrantsAdmin(scopes: readonly string[] | undefined): boolean {
  return !!scopes?.includes(ApiKeyScope.ADMIN);
}

/**
 * Makes `user.isAdmin` read false and `user.adminPermissions`, `user.adminRoleIds` and
 * `user.roleAdminPermissions` read `[]` for the rest of the request, whether or not the admin roles
 * (auth/adminRoles.ts) were resolved first. They are own accessors, so `save()`, `get(...)` and
 * `toJSON()` still see the stored values and nothing is written back. Assign a new array to change
 * permissions; an in-place push is lost.
 */
export function withholdAdminRole<T extends AdminFlagged>(user: T): T {
  const holdsAdminAccess =
    !!user.isAdmin ||
    !!user.adminPermissions?.length ||
    !!user.adminRoleIds?.length ||
    !!user.roleAdminPermissions?.length;
  if (!holdsAdminAccess) return user;
  Object.defineProperty(user, PERSISTED_ADMIN_ROLE, { value: !!user.isAdmin, configurable: true });
  for (const path of ['adminPermissions', 'adminRoleIds'] as const) {
    Object.defineProperty(user, path, {
      configurable: true,
      enumerable: true,
      get: () => [],
      set: (value: unknown) => {
        const doc = user as T & { set?: (path: string, value: unknown) => unknown };
        if (typeof doc.set === 'function') doc.set(path, value);
      },
    });
  }
  // Derived, never stored: a write (a late role resolution) has nothing to persist and stays hidden.
  Object.defineProperty(user, 'roleAdminPermissions', {
    configurable: true,
    enumerable: true,
    get: () => [],
    set: () => undefined,
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
  return ownerRereadAs(ownerId, users, withholdAdminRole);
}

/**
 * The `users` adapter for a service that re-reads the caller by id: the copy it gets back carries
 * what apiKeyAuth applied to `req.user` - the withheld admin role, and an org-owned key's reach
 * (b4m-core/common utils/orgApiKeyReach.ts), without which the re-read user would read as the bare
 * service account and every org-shared resource would 404.
 */
export function requesterScopedUsers<R extends UsersById>(req: ApiKeyRequest, users: R): R {
  if (!req.user) return users;
  const withhold = adminRoleWithheldFor(req.apiKeyInfo);
  const reach = orgApiKeyReachOf(req.user);
  if (!withhold && !reach) return users;
  return ownerRereadAs(String(req.user.id), users, user => {
    if (withhold) withholdAdminRole(user);
    if (reach) attachOrgApiKeyReach(user, reach);
    return user;
  });
}

function ownerRereadAs<R extends UsersById>(ownerId: string, users: R, apply: (user: AdminFlagged) => AdminFlagged): R {
  const findById = async (id: string) => {
    const user = await users.findById(id);
    return user && String(id) === ownerId ? apply(user) : user;
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
