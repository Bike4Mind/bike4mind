import type {
  AccessContext,
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
} from '@bike4mind/common';
import { classifyLakeAccess, type LakeAccessArm } from './classifyLakeAccess';
import type { LakeGrant } from './manageRule';
import { createScopedAsyncMemo } from './scopedAsyncMemo';

/** The platform cutover flag governing whether read-grant resolution is enforced or report-only. */
export const ENFORCE_LAKE_READ_GRANTS_KEY = 'EnforceLakeReadGrants' as const;

/**
 * Source-level interlock for the ENFORCE transition, now FLIPPED. It existed so an admin toggling
 * `EnforceLakeReadGrants` before the feature was code-complete could not activate a half-wired gate;
 * enforcement requires BOTH the setting ON and this constant true.
 *
 * Both of its stated exit criteria are now met: the retrieval/grounding read arm
 * (`getDynamicDataLakeAccess` resolves grants on the same terms browse does, so a reader who can
 * open a lake can also ground on it), and the member-management WRITE path (`manageLakeGrant`, the
 * first producer of reader/org grants). The resolution stays additive
 * (`resolvedAllowed = legacy || readGrant`), so nobody loses access at the flip. Cross-org
 * containment is held at both ends - `refuseGrantWrite` on the way in, `containedGrants` plus the
 * org-constrained repo arm on the way out.
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
 * Role is intentionally not inspected here: any grant a principal holds admits a READ. A user
 * owner/curator grant already passes the legacy `owner-admin` arm via canManageLake, so the outcomes
 * this newly flips are (a) a user `reader` grant and (b) an org grant of any role reaching a plain
 * member - the gaps #1673 closes. The org read arm keys off MEMBERSHIP (`ctx.organizationIds`),
 * distinct from canManageLake's org-MANAGE arm, which keys off admin rights.
 *
 * An org owner/curator grant held by an org ADMIN pre-passes that legacy arm only when the grant is
 * contained to the lake's own org (or the lake has none) - canManageLake's org-grant rung compares
 * the two. A CROSS-org org grant is denied there, so it arrives un-allowed and this arm would be
 * what decides it; `containedGrants` strips the row before it gets here, so the two gates agree.
 *
 * THIS ARM never lets an org grant reach a lake outside the granting org. Scoped deliberately: the
 * claim is about the read-grant arm, not about the whole decision - the legacy `canManageLake` org
 * rung it is ORed with has its own (weaker) rules. This function does not see the lake, so the
 * containment is applied by the caller BEFORE the rows reach here - `containedGrants` at the gate,
 * and the per-granting-org repo arms on the id-resolution path (see `grantedLakeReachFor`). A caller
 * that hands over raw rows gets no containment, which is why both live in this file.
 *
 * MUST STAY IN SYNC WITH THE WRITE PATH, which now exists: `refuseGrantWrite`
 * (`lakeGrantWriteRule.ts`) rejects an org-principal grant whose org is not the lake's own, so a bad
 * row is never persisted in the first place, and that refusal is pinned by its own unit test. The
 * read-time containment above is defense in depth for rows written before it, or by any FUTURE
 * producer - which must apply the same rule.
 *
 * SECOND OBLIGATION ON THAT WRITE PATH (#2495): an owner/curator grant is no longer read-only in its
 * effect. `getAccessibleDataLakePrompts` treats one as injection trust, so granting someone curator
 * also grants them "my lake's systemPrompt may enter your system prompt on turns you retrieve from
 * it".
 *
 * `manageLakeGrant` is the producer that raises that question directly: unlike `createDataLake` (which
 * only seeds the creator) and `transferLakeOwnership` (whose `resolveLakeTransferAuthority` refuses a
 * non-admin transfer of an ORG-LESS lake outright and constrains an org one to the owning org's own
 * roster), it can name an ARBITRARY user, by email, on any lake the actor manages. That is a consent
 * question, not just an access one, so the grant UI's curator option says what the role carries
 * rather than letting it ship as an invisible side effect of a role picker. Keep that disclosure in
 * step with the trust rule - a role that gains injection trust has to say so at the point of grant.
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
 * Defense in depth, not the primary guard - `refuseGrantWrite` refuses such a row on the way in
 * (see resolveReadGrant). This arm covers rows written before that rule existed, and any producer
 * that forgets it.
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
 * NEVER throws - an unwired repo OR a THROWN read degrades to `false` (report-only / legacy), because
 * a failed read is not a "yes": collapsing it into enforce would silently widen access on a transient
 * glitch. The warns are the diagnostics that tell "flag off" apart from "read failed" apart from
 * "operator enabled it but the interlock is still holding" - all three must be visible to a smoke test.
 *
 * THAT FAIL-SAFE DOES NOT REACH A NON-THROWING FAILURE, and the reason is in `getSettingsValue`: it
 * `safeParse`s the stored value and returns the setting's `defaultValue` on failure rather than
 * raising. `EnforceLakeReadGrants` ships `defaultValue: true`, so a missing row and an unparseable
 * one both resolve to ENFORCE, not to `false`. For the missing row that is the intended cutover
 * default; for a malformed row it is indistinguishable from it here, and the settings layer is where
 * that would have to be told apart.
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
  // make the premature toggle loud rather than half-enabling a gate whose arms are not all wired.
  if (intent && !READ_GRANT_ENFORCEMENT_READY) {
    logger?.warn?.(
      '[lakeReadGrantCutover] EnforceLakeReadGrants is ON but enforcement is code-gated off ' +
        '(the interlock constant is off); staying report-only'
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
 *
 * A NEW PARAMETER HERE MUST BE ADDED TO `grantedLakeReachForTurn`'S MEMO KEY, which is built from
 * this signature's arguments by hand. An argument the key omits merges two call sites that meant to
 * differ - and the sites that differ, differ on exactly the security floor (see that key's doc).
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

/** Backing store for `grantedLakeReachForTurn` - see its doc for what the key has to cover. */
const reachByTurn = createScopedAsyncMemo<LakeGrantReach>();

/**
 * `grantedLakeReachFor`, resolved at most ONCE per turn per distinct argument set. For the callers
 * that run it repeatedly inside one request: the knowledge tools resolve lake access per TOOL
 * CALL, so a turn that grounds through forced retrieval and then calls both `search` and
 * `retrieve` issues this read four times over. `turnScope` must be an object whose lifetime IS
 * the turn - the shared `ToolContext`, built once per request in `generateTools` and closed over
 * by every tool. Callers that read once, and every browse/manage caller, keep calling
 * `grantedLakeReachFor` directly.
 *
 * THE REACH IT RETURNS IS SHARED between every caller that hits the entry, so treat it as
 * read-only: mutating either half would reach the other calls in the turn. Today's consumers copy
 * the ids out (`grantedLakeIds` into a Set) or hand the whole reach to a query that only reads it.
 *
 * THE KEY COVERS `includeReaders` AND `organizationIds`, not just the user. The retrieval and
 * prompt-injection sites pass deliberately different arguments and are meant to stay diverged:
 * retrieval follows the enforced cutover, while injection pins `includeReaders: false` forever,
 * because a reader's READ access must not become authority to write instructions into another
 * user's system prompt. A user-keyed memo would silently merge two sets whose separation is
 * exactly the point. Org ids are sorted so caller-side ordering cannot split an entry in two.
 *
 * The grant repo is NOT in the key - being an object, it cannot be - so `turnScope` has to be the
 * object that OWNS it (a ToolContext owns `db.dataLakeAccessGrants`). Handing one scope two
 * different grant repos would share one entry between them.
 *
 * The reach is a per-turn SNAPSHOT: `activeAsOf` is captured by the first call, and a grant
 * revoked or lapsed after it stays honored for the rest of that turn. Deliberate - a turn is
 * seconds long, the alternative is the repeated read this exists to remove, and the retrieval side
 * already snapshots this way - `knowledgeBaseRetrieve` holds one resolved lake-access set for the
 * length of a tool call (`dynamicAccessPromise`). The manage re-check on a session's pre-authorized
 * ids is NOT part of the snapshot: `filterStillManagedLakes` reads `listActiveByLakes` per call.
 */
export const grantedLakeReachForTurn = (
  turnScope: object,
  userId: string,
  organizationIds: string[],
  grants?: PrincipalGrantLookup,
  includeReaders = false
): Promise<LakeGrantReach> =>
  reachByTurn(turnScope, JSON.stringify([userId, includeReaders, [...organizationIds].sort()]), () =>
    grantedLakeReachFor(userId, organizationIds, grants, includeReaders)
  );

/**
 * Lake ids the caller can reach via a MANAGE-conferring active grant - the narrower sibling of
 * `grantedLakeReachFor`, for the management views (archived / deleted / transitional) whose only
 * offered action is a restore, cleanup or retry.
 *
 * Narrower two ways. By ROLE: owner/curator only, allow-listed rather than excluding `reader`, so a
 * role added to DATA_LAKE_ACCESS_ROLES (called out there as an additive change) fails closed here
 * until someone decides it manages. A reader grant is read access and confers no restore - the same
 * ground these views already pass includePublic:false on.
 *
 * By PRINCIPAL: user grants only, so the return type is a bare id list rather than a
 * `LakeGrantReach`. An org grant carries no role through `orgGrantArms`, so DataLakeModel already
 * suppresses those arms alongside the public one whenever `includePublic:false` - which is exactly
 * the three views this feeds. Resolving an org reach here would therefore be dead weight. Given up
 * with it either way: an org-LESS lake carrying an org grant, which `orgGrantArms` also never
 * matches. A SAME-org lake is unaffected - it arrives via findAccessible's own administeredOrgIds
 * arm, which carries the lake-org containment an id list cannot.
 *
 * Reads no cutover flag, unlike `grantedLakeReachFor`'s `includeReaders`: owner/curator grants have
 * live, unflagged producers (createDataLake, transferLakeOwnership) and the rungs that honor them
 * are live too, so gating this on the read-grant cutover would withhold ids the manage gate accepts.
 */
export const manageGrantedLakeIdsFor = async (userId: string, grants?: PrincipalGrantLookup): Promise<string[]> => {
  if (!grants) return [];
  const rows = await grants.listByPrincipal('user', userId, { activeAsOf: new Date() });
  const manageable = rows.filter(row => row.role === 'owner' || row.role === 'curator');
  return Array.from(new Set(manageable.map(row => row.dataLakeId)));
};
