import * as z from 'zod';
import type { OrgApiKeyGrant } from '../types/entities/UserApiKeyTypes';

const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'Expected an id');

/** Wire shape of IUserApiKey.orgOwned.grants, shared by the org key routes and their picker. */
export const OrgApiKeyGrantSchema = z.discriminatedUnion('resourceType', [
  z.object({ resourceType: z.literal('organization'), resourceId: objectIdString, permission: z.literal('read') }),
  z.object({ resourceType: z.literal('group'), resourceId: objectIdString, permission: z.literal('read') }),
]) satisfies z.ZodType<OrgApiKeyGrant>;

export const MAX_ORG_API_KEY_GRANTS = 50;

export const OrgApiKeyGrantsSchema = z.array(OrgApiKeyGrantSchema).max(MAX_ORG_API_KEY_GRANTS);

/**
 * What an org-owned key may read on one request, resolved from its grants against the live org
 * (apps/client/server/organizations/orgApiKeyReach.ts). Read-only by construction: the read paths
 * below consult it, the write paths keep reading the account's own (empty) `groups`.
 */
export type OrgApiKeyReach = {
  organizationId: string;
  /** Org groups whose `groups[]` shares the key may read. */
  readGroupIds: string[];
  /** Orgs whose org-scoped data lakes the key may read (the org itself, or nothing). */
  dataLakeOrgIds: string[];
};

// Symbol.for, not Symbol(): the database and server-utils bundles can each carry their own copy of
// this module, and both must see the reach apiKeyAuth attached.
const ORG_API_KEY_REACH = Symbol.for('bike4mind.orgApiKeyReach');

/**
 * Attaches `reach` to the request's user for the rest of the request. A non-enumerable symbol, so
 * `save()`, `toJSON()` and any spread or copy drop it: it is never persisted, and a copied user
 * fails closed to the account's own reach.
 */
export function attachOrgApiKeyReach<T extends object>(user: T, reach: OrgApiKeyReach): T {
  Object.defineProperty(user, ORG_API_KEY_REACH, { value: reach, configurable: true, enumerable: false });
  return user;
}

export function orgApiKeyReachOf(user: object | null | undefined): OrgApiKeyReach | undefined {
  if (!user) return undefined;
  const reach: unknown = Reflect.get(user, ORG_API_KEY_REACH);
  return reach && typeof reach === 'object' ? (reach as OrgApiKeyReach) : undefined;
}

/**
 * The group ids whose `groups[]` shares grant this user READ: their own memberships plus an org key's
 * granted groups. Read paths only (the CASL read arm, SharableDocumentModel's read arms, file search);
 * update, delete and share arms keep `user.groups`, so a grant never confers write.
 */
export function readableGroupIds(user: { groups?: readonly string[] | null }): string[] {
  const own = user.groups ?? [];
  const granted = orgApiKeyReachOf(user)?.readGroupIds ?? [];
  return granted.length === 0 ? [...own] : [...new Set([...own, ...granted])];
}
