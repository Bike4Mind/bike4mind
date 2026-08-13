import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// ── Data Lake Access Grant ───────────────────────────────────────────────────
//
// A first-class access-membership relation for a data lake: a persisted row granting one
// principal (a user or an organization) a role on one lake. This is the "who can reach this
// lake" record the lake never had - previously access was a string tag (`requiredUserTag`)
// sprayed onto user documents and matched at read time, so it could not be listed, audited,
// expired, delegated or revoked as a set.
//
// NAMING: deliberately "AccessGrant", NOT "membership". `DataLakeMembershipScope` /
// `buildDataLakeMembershipFilter` / `lakeMembership.ts` already exist and mean FILE-in-lake
// membership (is this FabFile a member of this lake). This relation is USER/ORG-to-lake access.
//
// SCOPE: this module is the relation and its roles ONLY. Resolving tag/entitlement grants into
// an ephemeral view (#1673) and materializing the org set into the access context (#1674) are
// siblings; nothing here reads a grant into an authorization decision yet.

/**
 * Roles on a lake, most-privileged first (owner > curator > reader). A curator can add, remove
 * and reprocess members without being a platform admin - the point of the relation is to remove
 * the superuser from routine lake operations. Enforcement of what each role may do lands with the
 * write path (#1668); this is the vocabulary.
 */
export const DATA_LAKE_ACCESS_ROLES = ['owner', 'curator', 'reader'] as const;
export type DataLakeAccessRole = (typeof DATA_LAKE_ACCESS_ROLES)[number];

/**
 * What kind of principal a grant is for. The `group` arm is deliberately DEFERRED (issue #1667):
 * the group model is a frozen three-entry catalog, org-required, one live group per (org, type),
 * creatable only by a platform admin, and the production Group collection is empty - so no grant
 * targets a group yet. It is left out of the union rather than stored-and-ignored (a value nothing
 * reads is the anti-pattern this epic names); adding it later is an additive enum change.
 */
export const DATA_LAKE_PRINCIPAL_TYPES = ['user', 'organization'] as const;
export type DataLakePrincipalType = (typeof DATA_LAKE_PRINCIPAL_TYPES)[number];

export const DataLakeAccessGrant = z.object({
  /**
   * The granting lake's Mongo `_id`. ALWAYS a persisted DB lake: a hardcoded/fallback lake has no
   * backing document to hang a grant on (its id is a human slug, never an ObjectId), so the write
   * boundary refuses one via `assertLakeGrantable`. That is the explicit fallback carve-out issue
   * #1667 calls for - enforced at the service layer, where the static registry is known, not here.
   */
  dataLakeId: z.string(),
  principalType: z.enum(DATA_LAKE_PRINCIPAL_TYPES),
  /** The granted principal's id - a userId or an organizationId, per `principalType`. */
  principalId: z.string(),
  role: z.enum(DATA_LAKE_ACCESS_ROLES),
  /** The actor (userId) who created the grant. */
  grantedByUserId: z.string(),
  /**
   * Optional expiry for a time-boxed grant (trials, temporary internal collaborators,
   * evaluations). A grant is expired once `expiresAt` is set and in the past. Expired rows are
   * filtered at READ time by grant resolution (#1673) and are deliberately NOT swept from the
   * collection, so an owner-facing membership view (#1672) and the audit trail (#1663) can still
   * render a lapsed grant. Absent/null = never expires.
   *
   * Only meaningful for a principal INSIDE the lake's organization: membership never crosses
   * organizations (epic decision 12), so this is not a cross-org mechanism.
   */
  expiresAt: z.date().nullish(),
});

/**
 * The persisted grant content. `createdAt` (from Mongoose timestamps, via `IMongoDocument`) IS the
 * grant time ("granted-at"); there is no separate field, so the two cannot drift. A role change
 * updates the same row (see `upsertGrant`) and bumps `updatedAt`, leaving `createdAt` as the
 * moment the principal was first granted.
 */
export type IDataLakeAccessGrant = z.infer<typeof DataLakeAccessGrant>;

export interface IDataLakeAccessGrantDocument extends IDataLakeAccessGrant, IMongoDocument {}

export interface IDataLakeAccessGrantRepository extends IBaseRepository<IDataLakeAccessGrantDocument> {
  /**
   * Every grant on a lake - the "who can reach this lake" answer that motivates the relation.
   * With `activeAsOf`, grants that have expired by that instant are dropped (a never-expiring grant
   * always stays); without it, expired rows are included (the audit/membership-view use).
   */
  listByLake(dataLakeId: string, opts?: { activeAsOf?: Date }): Promise<IDataLakeAccessGrantDocument[]>;
  /**
   * Every grant a principal holds, across all lakes - the input read-time resolution (#1673) needs
   * to answer "which lakes can this principal reach". Same `activeAsOf` expiry filter as
   * `listByLake`.
   */
  listByPrincipal(
    principalType: DataLakePrincipalType,
    principalId: string,
    opts?: { activeAsOf?: Date }
  ): Promise<IDataLakeAccessGrantDocument[]>;
  /** The single grant for (lake, principal), or null. */
  findGrant(
    dataLakeId: string,
    principalType: DataLakePrincipalType,
    principalId: string
  ): Promise<IDataLakeAccessGrantDocument | null>;
  /**
   * Create the grant for (lake, principal), or update the existing one in place (role / grantedBy /
   * expiry). Idempotent on the (dataLakeId, principalType, principalId) key, so there is at most one
   * live grant per principal per lake. `expiresAt` omitted leaves any existing expiry unchanged;
   * pass `null` to clear it.
   */
  upsertGrant(input: IDataLakeAccessGrant): Promise<IDataLakeAccessGrantDocument>;
  /** Revoke a principal's grant on a lake. Returns whether a row was actually removed. */
  removeGrant(dataLakeId: string, principalType: DataLakePrincipalType, principalId: string): Promise<boolean>;
  /**
   * Cascade-remove every grant on a lake. The delete/teardown path must call this so a deleted
   * lake leaves no orphaned grants behind. Returns the number of rows removed.
   */
  removeAllForLake(dataLakeId: string): Promise<number>;
}
