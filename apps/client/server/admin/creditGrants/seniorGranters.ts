import { ForbiddenError, isExplicitOnlyAdminPermission } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';

/**
 * Senior credit granters: user ids from the ADMIN_SENIOR_GRANTER_IDS secret (infra/secrets.ts), which no admin
 * can change from the app. Only a listed account can hold the explicit-only credit permissions
 * (EXPLICIT_ONLY_ADMIN_PERMISSIONS in b4m-core/common adminPermissions.ts): they are refused at grant time
 * (assertListedForExplicitOnly) and ignored at use time (fenceExplicitOnlyPermissions). Unset, empty or
 * all-invalid means nobody is listed.
 */

const USER_ID = /^[0-9a-f]{24}$/i;

/** Comma-separated user ids: trimmed, empties dropped, anything but a 24-hex id ignored with a warning. */
export function parseSeniorGranterIds(raw: string | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  let ignored = 0;
  for (const entry of (raw ?? '').split(',')) {
    const id = entry.trim();
    if (!id) continue;
    if (USER_ID.test(id)) ids.add(id.toLowerCase());
    else ignored++;
  }
  // The count only: a mistyped entry may be an email.
  if (ignored > 0) Logger.globalInstance.warn('[seniorGranters] ignored invalid senior granter ids', { ignored });
  return ids;
}

let parsed: { raw: string | undefined; ids: ReadonlySet<string> } | undefined;

export function isSeniorGranter(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const raw = Config.ADMIN_SENIOR_GRANTER_IDS;
  if (!parsed || parsed.raw !== raw) parsed = { raw, ids: parseSeniorGranterIds(raw) };
  return parsed.ids.has(userId.toLowerCase());
}

type FencedActor = {
  id: string;
  impersonatedBy?: string | null;
  adminPermissions?: readonly string[] | null;
  roleAdminPermissions?: readonly string[] | null;
};

/**
 * The actor as the explicit-only permissions should see it: unchanged for a listed account in its own
 * session, otherwise with those permissions removed. An impersonated session never borrows them.
 */
export function fenceExplicitOnlyPermissions<T extends FencedActor>(actor: T): T {
  if (!actor.impersonatedBy && isSeniorGranter(actor.id)) return actor;
  const keep = (ids: readonly string[] | null | undefined) => ids?.filter(id => !isExplicitOnlyAdminPermission(id));
  return {
    ...actor,
    adminPermissions: keep(actor.adminPermissions),
    roleAdminPermissions: keep(actor.roleAdminPermissions),
  };
}

/**
 * Refuses a change that gives an unlisted account an explicit-only permission it did not hold before,
 * directly or through a role. `before` and `after` are its effective permission sets; removing is never refused.
 */
export function assertListedForExplicitOnly(
  targetId: string,
  before: readonly string[],
  after: readonly string[]
): void {
  const added = after.filter(id => isExplicitOnlyAdminPermission(id) && !before.includes(id));
  if (added.length > 0 && !isSeniorGranter(targetId)) {
    throw new ForbiddenError(
      `${[...new Set(added)].join(', ')} can only be held by an account on the deployment's senior granter list`
    );
  }
}
