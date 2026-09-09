import type {
  AccessContext,
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
} from '@bike4mind/common';
import { classifyLakeAccess, type LakeAccessArm } from './classifyLakeAccess';
import type { LakeGrant } from './manageRule';

/** The platform cutover flag governing whether read-grant resolution is enforced or report-only. */
export const ENFORCE_LAKE_READ_GRANTS_KEY = 'EnforceLakeReadGrants' as const;

/**
 * Source-level interlock for the ENFORCE transition, now FLIPPED. It existed so an admin toggling
 * `EnforceLakeReadGrants` before the feature was code-complete could not activate a half-wired gate;
 * enforcement requires BOTH the setting ON and this constant true.
 *
 * Its stated exit criteria were two: the retrieval/grounding read arm, and the member-management
 * WRITE path. The retrieval arm is now in place (`getDynamicDataLakeAccess` resolves grants on the
 * same terms browse does), so a reader who can open a lake can also ground on it. The WRITE path is
 * DELIBERATELY still outstanding - stated plainly rather than quietly dropped. Enforcing without it
 * is safe by construction: the resolution is additive (`resolvedAllowed = legacy || readGrant`), so
 * nobody loses access, and the only grant producers today are createDataLake (owner) and
 * transferLakeOwnership (owner/curator), both user-principal. The live delta at the flip is
 * therefore that transferred owners and curators regain grounding. The containment duty that
 * docblock delegated to the missing writer is taken over at read time by `containedGrants` and the
 * org-constrained repo arm; the writer must still refuse a cross-org row when it lands.
 *
 * Now vestigial - `resolveEnforceReadGrants` reduces to the setting alone - but retained as the
 * auditable seam the cutover tests branch on, and as the kill switch if enforcement has to be
 * backed out without a settings migration. The premature-toggle warn stays for the same reason.
 */
export const READ_GRANT_ENFORCEMENT_READY = true;

/** Minimal diagnostic sink - a structural subset of the app Logger, so no dependency is added here. */
export interface LakeAccessLogger {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
}

/**
 * The NEW explicit read-grant arm (#1673): true when the caller holds a grant on this lake, either
 * as a USER principal (matching `userId`) or as a member of an ORGANIZATION principal (the granted
 * org is one of `ctx.organizationIds`). The grant row IS the authorization - it needs none of the
 * org/gate constraints (the analog of the createdByUserId owner bypass, extended to a delegated
 * reader/curator/owner and to org-shared lakes) and it bypasses Private-by-default. `grants` is
 * pre-filtered to ACTIVE (expiry) by the caller, so a lapsed grant never reaches here.
 *
 * Role is intentionally not inspected here: any grant a principal holds admits a READ. Owner/curator
 * (and org owner/curator for an org ADMIN) already pass the legacy `owner-admin` arm via
 * canManageLake, so the outcomes this newly flips are (a) a user `reader` grant and (b) an org grant
 * of any role reaching a plain member - the gaps #1673 closes. The org read arm keys off MEMBERSHIP
 * (`ctx.organizationIds`), distinct from canManageLake's org-MANAGE arm, which keys off admin rights.
 *
 * THIS ARM never lets an org grant reach a lake outside the granting org. Scoped deliberately: the
 * claim is about the read-grant arm, not about the whole decision - the legacy `canManageLake` org
 * rung it is ORed with has its own (weaker) rules. This function does not see the lake, so the
 * containment is applied by the caller BEFORE the rows reach here - `containedGrants` at the gate,
 * and the per-granting-org repo arms on the id-resolution path (see `grantedLakeReachFor`). A caller
 * that hands over raw rows gets no containment, which is why both live in this file.
 *
 * STILL MUST STAY IN SYNC WITH THE WRITE PATH: the read side now asserts that rule as defense in
 * depth, but whoever builds the member-management write path (grant a reader / grant an org - no
 * such producer exists yet; only createDataLake seeds an owner and transferLakeOwnership demotes to
 * curator) MUST still reject an org-principal grant whose org is not the lake's own org, so a bad
 * row is never persisted in the first place.
 */
export function resolveReadGrant(
  ctx: Pick<AccessContext, 'userId' | 'organizationIds'>,
  grants: readonly LakeGrant[]
): boolean {
  const orgIds = ctx.organizationIds ?? [];
  return grants.some(g =>
    g.principalType === 'user'
      ? !!ctx.userId && g.principalId === ctx.userId
      : g.principalType === 'organization' && orgIds.includes(g.principalId)
  );
}

/**
 * Org containment at read time: an ORG-principal grant is honored ONLY on a lake belonging to that
 * same org - compared against the GRANTING org, never against "some org the caller happens to be in"
 * (a caller in two orgs would otherwise carry an orgA grant onto an orgB lake). An org-less
 * (personal) lake therefore matches no org grant, which is the same rule the grant writer applies
 * when it refuses to create one; without it, moving a lake org -> personal would leave a grant this
 * gate honored forever, since lake deletion is the only grant-removal path in the tree.
 *
 * USER-principal grants are untouched: they are meant to cross orgs (a transferred owner who has
 * since moved).
 *
 * Defense in depth, not the primary guard - the write path is still expected to refuse such a row
 * (see resolveReadGrant). It exists because enforcement ships before that writer does, so without it
 * the containment property would rest on nothing.
 *
 * MUST STAY EQUIVALENT to the per-granting-org repo arms built from `LakeGrantReach.orgGrantedLakes`
 * (DataLakeModel `orgGrantArms`): that is the same rule on the id-resolution path, which has no
 * second gate behind it.
 */
export const containedGrants = <T extends LakeGrant>(
  lake: Pick<IDataLakeDocument, 'organizationId'>,
  grants: readonly T[]
): T[] => {
  const lakeOrgId = lake.organizationId ? String(lake.organizationId) : '';
  return grants.filter(g => g.principalType !== 'organization' || g.principalId === lakeOrgId);
};

/** The decomposed read decision: the legacy arm, the new read-grant arm, and what each would allow. */
export interface LakeReadAccessDecision {
  /** The ENFORCED decision: the legacy decision in report-only, the grant-resolved decision when enforcing. */
  allowed: boolean;
  /** What the legacy five-arm gate decided (the report-only fallback). */
  legacyAllowed: boolean;
  /** Which legacy arm produced `legacyAllowed`. */
  legacyArm: LakeAccessArm;
  /** Whether an explicit user read grant admits the caller. */
  readGrantAllows: boolean;
  /** legacyAllowed OR readGrantAllows - the decision once the cutover is enforced. */
  resolvedAllowed: boolean;
  /** True when the read grant CHANGES the legacy outcome (always deny -> allow: a reader grant). */
  diverges: boolean;
  /** Whether this decision was enforced (`allowed === resolvedAllowed`) or report-only. */
  enforced: boolean;
}

/**
 * Resolve read access with the ephemeral membership view layered onto the legacy gate. In report-only
 * mode (`enforceReadGrants: false`) the ENFORCED decision stays the legacy one, so nothing changes for
 * users while the cutover is observed; the caller logs `diverges` to build the expected-grant-set diff.
 * Once enforced, a persisted read grant admits the caller. Pure/sync - the same seam as classifyLakeAccess.
 */
export function resolveLakeReadAccess(
  lake: Pick<
    IDataLakeDocument,
    'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'
  >,
  ctx: AccessContext,
  grants: readonly LakeGrant[] = [],
  opts: { enforceReadGrants: boolean }
): LakeReadAccessDecision {
  const legacy = classifyLakeAccess(lake, ctx, grants);
  // Only the read-grant arm is contained. `classifyLakeAccess` gets the raw rows: its grant use is
  // the owner/curator MANAGE rung (canManageLake), which has its own org rules.
  const readGrantAllows = resolveReadGrant(ctx, containedGrants(lake, grants));
  const resolvedAllowed = legacy.allowed || readGrantAllows;
  return {
    allowed: opts.enforceReadGrants ? resolvedAllowed : legacy.allowed,
    legacyAllowed: legacy.allowed,
    legacyArm: legacy.arm,
    readGrantAllows,
    resolvedAllowed,
    diverges: resolvedAllowed !== legacy.allowed,
    enforced: opts.enforceReadGrants,
  };
}

/**
 * Whether read-grant resolution is ENFORCED right now. Enforcement requires BOTH the platform setting
 * ON and the source-level `READ_GRANT_ENFORCEMENT_READY` interlock (see its doc) - so a premature
 * admin toggle stays report-only until the feature is code-complete. Platform altitude on purpose:
 * the setting is a one-time install-wide migration cutover, not a per-lake lever.
 *
 * NEVER throws - an unwired repo OR a failed read degrades to `false` (report-only / legacy), because
 * a failed read is not a "yes": collapsing it into enforce would silently widen access on a transient
 * glitch. The warns are the diagnostics that tell "flag off" apart from "read failed" apart from
 * "operator enabled it but the interlock is still holding" - all three must be visible to a smoke test.
 */
export async function resolveEnforceReadGrants(
  settings: Pick<IAdminSettingsRepository, 'getSettingsValue'> | undefined,
  logger?: LakeAccessLogger
): Promise<boolean> {
  if (!settings) return false;
  let intent = false;
  try {
    intent = (await settings.getSettingsValue(ENFORCE_LAKE_READ_GRANTS_KEY)) === true;
  } catch (err) {
    logger?.warn?.('[lakeReadGrantCutover] enforce-flag read failed; treating as report-only', err);
    return false;
  }
  // Interlock: the operator asked to enforce, but the feature is not code-ready. Stay report-only and
  // make the premature toggle loud rather than half-enabling it before the member-write path exists.
  if (intent && !READ_GRANT_ENFORCEMENT_READY) {
    logger?.warn?.(
      '[lakeReadGrantCutover] EnforceLakeReadGrants is ON but enforcement is code-gated off ' +
        '(member-write path not wired); staying report-only'
    );
    return false;
  }
  return intent && READ_GRANT_ENFORCEMENT_READY;
}

/** Grant-repo slice the id resolution needs: one principal's active grants. */
type PrincipalGrantLookup = Pick<IDataLakeAccessGrantRepository, 'listByPrincipal'>;

/**
 * Lake ids the caller can reach via an active grant, SPLIT BY PRINCIPAL because the two halves earn
 * different bypasses in the datastore filters - see the field docs. Fed to findAccessible,
 * findPublicLakes and findActiveByUserTagsAndEntitlements so a transferred, delegated or shared lake
 * lists, discovers AND grounds.
 */
export interface LakeGrantReach {
  /**
   * USER-principal reach: an UNCONDITIONAL bypass of the org and gate constraints, the analog of the
   * createdByUserId owner bypass. It is meant to cross orgs - a transferred owner who has since
   * moved orgs still reaches the lake they own.
   */
  grantedLakeIds: string[];
  /**
   * ORG-principal reach, KEYED BY THE GRANTING ORG (orgId -> lake ids granted by that org).
   * Bypasses the GATE only: each org's ids are ANDed in the datastore with `organizationId: orgId`,
   * so a grant reaches only a lake inside the org that issued it - the id path's counterpart to
   * `containedGrants` at the gate. Flattening this to a bare id list is what let an orgA grant lift
   * the gate on an orgB lake for a caller who belongs to both, so the granting org must survive
   * the trip to the repo.
   */
  orgGrantedLakes: Record<string, string[]>;
}

/**
 * Resolve both reach sets. Stays in lockstep with the single read gate (#1673):
 *  - USER owner/curator ALWAYS included: the gate admits them via `canManageLake`.
 *  - USER reader AND any ORG-principal grant (for an org the caller is a MEMBER of) included ONLY
 *    when `includeReaders` (the enforced read-time grant cutover), matching resolveReadGrant at the
 *    gate. In report-only the gate returns the legacy decision, so a lake reachable only by these
 *    would 404 on open - listing it would be incoherent, so it is excluded until enforce.
 * The org arm keys off MEMBERSHIP (`organizationIds`), distinct from the org-MANAGE rung (admin
 * rights).
 */
export const grantedLakeReachFor = async (
  userId: string,
  organizationIds: string[],
  grants?: PrincipalGrantLookup,
  includeReaders = false
): Promise<LakeGrantReach> => {
  if (!grants) return { grantedLakeIds: [], orgGrantedLakes: {} };
  const activeAsOf = new Date();
  const ids = new Set<string>();
  const byOrg = new Map<string, Set<string>>();

  const userRows = await grants.listByPrincipal('user', userId, { activeAsOf });
  for (const row of userRows) {
    if (row.role === 'owner' || row.role === 'curator' || (includeReaders && row.role === 'reader')) {
      ids.add(row.dataLakeId);
    }
  }

  // Org-principal grants resolve only under enforce: membership in an org holding ANY grant on a
  // lake grants read (mirrors the gate's org read arm). One query per membership org - bounded by
  // how many orgs the caller belongs to.
  if (includeReaders && organizationIds.length > 0) {
    const orgRowSets = await Promise.all(
      organizationIds.map(
        async orgId => [orgId, await grants.listByPrincipal('organization', orgId, { activeAsOf })] as const
      )
    );
    for (const [orgId, rows] of orgRowSets) {
      for (const row of rows) {
        // A lake reached both ways needs only the stronger (unconditional) user arm.
        if (ids.has(row.dataLakeId)) continue;
        const bucket = byOrg.get(orgId) ?? new Set<string>();
        bucket.add(row.dataLakeId);
        byOrg.set(orgId, bucket);
      }
    }
  }

  return {
    grantedLakeIds: Array.from(ids),
    orgGrantedLakes: Object.fromEntries(Array.from(byOrg, ([orgId, lakeIds]) => [orgId, Array.from(lakeIds)])),
  };
};
