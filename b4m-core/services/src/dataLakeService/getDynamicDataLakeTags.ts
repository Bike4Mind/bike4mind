import {
  DATA_LAKES,
  DataLakeConfig,
  getAccessibleDataLakes,
  toDataLakeConfig,
  type DataLakeMembershipScope,
  type IAdminSettingsRepository,
  type IDataLakeAccessGrantRepository,
  type IDataLakeRepository,
  type IFallbackLakeSettingsRepository,
  type IOrganizationRepository,
} from '@bike4mind/common';
import { usableObjectIds } from '@bike4mind/db-core';
import type { Logger } from '@bike4mind/observability';
import { isDatalakeTagWellFormed } from './createDataLake';
import { lakeMembershipScope, registryMembershipScope } from './lakeMembershipScope';
import {
  grantedLakeReachForTurn,
  resolveEnforceReadGrantsResult,
  supersededOwnLakeIdsForTurn,
  type LakeGrantReach,
} from './resolveLakeReadAccess';
import { membershipOrgIdsForTurn } from './membershipOrgIdsForTurn';

/**
 * The minimal context the data-lake access resolver needs. The knowledge tools
 * (ToolContext), the forced-retrieval feature (ChatCompletionContext), and the app-layer
 * semantic-search route (via server/dataLakes/resolveRetrievalLakeScope) all satisfy this
 * structurally, so this is the ONE shared resolver - no per-call-site duplicate.
 *
 * Non-goal: this resolver has NO admin/developer bypass and must not grow one. A privileged
 * widening here would reach every admin's chat session and pull other tenants' documents
 * into the model context. Surfaces that need one apply it outside, on their own result.
 */
export interface DataLakeAccessContext {
  db: {
    dataLakes?: Pick<
      IDataLakeRepository,
      | 'findActiveByUserTags'
      | 'findActiveByUserTagsAndEntitlements'
      | 'countGateExcludedLakes'
      | 'findById'
      | 'findIdsCreatedBy'
    >;
    /**
     * Resolves the caller's org membership set (owner + `users[]` ACL) internally from
     * `user.id` - required so an absent resolver can't silently drop every org lake (#1674).
     */
    organizations: Pick<IOrganizationRepository, 'findMembershipOrgIds'>;
    /**
     * Optional overlay lookup for a static (registry) lake's `systemPrompt` (Phase 2 - see
     * IFallbackLakeSetting). Used only by getDataLakePrompts' registry-candidate branch; absent
     * means zero registry lakes ever contribute a prompt, matching every other optional adapter
     * here (degrade to "this lever does nothing" rather than throw).
     */
    fallbackLakeSettings?: Pick<IFallbackLakeSettingsRepository, 'findByLakeIds'>;
    /**
     * Persisted access grants, so a lake reached ONLY by a grant (a transferred or delegated
     * owner, a curator, and under enforce a reader or an org principal) grounds as well as it
     * browses - the same arm `listDataLakes`/`browsePublicDataLakes` already pass to the repo.
     * Absent means retrieval sees no grants at all, which is what made browse and retrieval
     * disagree for a grant-held lake, so every retrieval host should wire it. Kept optional like
     * every other adapter here: a host without a grant repo has no grants to miss.
     *
     * Stays in lockstep with the browse side's `grantedLakeReachFor` call in listDataLakes - the
     * same helper resolved against the same setting, so retrieval remains a subset of browse (see
     * resolveRetrievalLakeScope's header) rather than growing an arm browse lacks.
     */
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByPrincipal' | 'listActiveByLakes'>;
    /**
     * Reads the `EnforceLakeReadGrants` cutover flag. Named to match ToolContext/
     * ChatCompletionContext, which already carry it, so every chat and tool surface satisfies this
     * structurally. Absent means report-only, which here means the reader and org rungs stay out of
     * the retrieval set (owner/curator grants resolve either way, matching `grantedLakeReachFor`'s
     * own split).
     */
    adminSettings?: Pick<IAdminSettingsRepository, 'getSettingsValue'>;
  };
  /**
   * The caller. Membership is resolved internally from `id` via `db.organizations` - there is
   * NO `organizationId` input here: that field was the selected-org display pointer, which is
   * not necessarily a membership (#1674). `id` is the owner bypass - the caller always retrieves
   * their own lakes (re-checked in memory against each lake's persisted `createdByUserId`, not
   * assumed from the query), and a gateless org-less lake is owner-only (Private-by-default).
   * An id-less caller resolves to the empty membership set (member of nothing).
   */
  user: {
    id?: string | { toString(): string } | null;
    tags?: string[] | null;
  };
  /** Caller's resolved entitlement keys; absent means tag-only matching. */
  entitlementKeys?: string[];
  /**
   * False ONLY when the caller's entitlement lookup THREW and `entitlementKeys` is therefore the
   * fail-safe `[]`, not the caller's real keys (#3155) - distinct from an absent/true value, which
   * means the keys above are trustworthy (including a legitimately empty list). An entitlement-gated
   * lake looks the same as an excluded one to `countGateExcludedLakes` either way, so a resolver
   * that cannot tell them apart must not report a confident exclusion count - see
   * `excludedByAccessCountPrerequisitesComplete` at this file's resolvers for how this feeds that
   * gate, mirroring the grant-read and supersession prerequisites already tracked there.
   */
  entitlementKeysResolved?: boolean;
  /** Optional; only used to report a swallowed dataLakes read failure (see below). */
  logger?: Logger;
}

/**
 * One accessible lake, resolved far enough to run a WHOLE-LAKE query against it (counting,
 * stats) rather than only a tag-matched search. Exists because the tag/prefix sets below are
 * flattened unions: they answer "may this file be searched" but lose which lake a file belongs
 * to, the creator its prefix arm is anchored to, and the lake's product-facing name.
 *
 * `source` is load-bearing, not decoration: it is what tells a consumer whether this lake's
 * `membership` is creator-anchored (`owned`) or unanchored (`registry`), and only the former may
 * enter a cross-lake `$or` - see `lakeMembershipsFrom`.
 */
export interface ResolvedLakeAccess {
  id: string;
  name: string;
  slug: string;
  datalakeTag: string;
  fileTagPrefix: string;
  /**
   * The whole-lake membership predicate - the same scope the single-lake browse and every
   * lifecycle write run on, so a count built from it equals the lake page's total.
   *
   * REQUIRED, for both lake kinds, and deliberately not optional. Every construction site must
   * produce one (`lakeMembershipScope` for a DB lake, `registryMembershipScope` for a registry
   * lake), because an absent value used to force each whole-lake consumer to hand-roll its own
   * registry fallback - and the count surface's copy drifted from the browse's and under-counted
   * every registry lake. A required field is what makes that class of drift unrepresentable.
   */
  membership: DataLakeMembershipScope;
  source: 'registry' | 'dynamic';
}

/**
 * The membership arms a MULTI-LAKE retrieval query may carry: one per lake whose scope is
 * creator-anchored. Registry lakes have a scope too, but an unanchored one, so they are dropped
 * here and keep matching through the OPEN `dataLakeTagPrefixes` arm instead.
 *
 * INVARIANT: every scope this returns is creator-anchored. A registry scope's prefix arm carries
 * no ownership conjunct (see `buildDataLakeMembershipFilter`), so beside other lakes' arms in one
 * shared `$or` it stops being that lake's arm and becomes an unanchored prefix match any of the
 * OR'd lakes can ride - the cross-tenant promotion the SCOPED/OPEN split exists to forbid.
 *
 * This `kind` filter is the ONLY guard on that. It used to be the second of two, backed by
 * "`membership` is set only on the dynamic branch"; every lake now carries a scope, so presence
 * proves nothing and the discriminant #2216 added is the whole check. It is an ALLOW-list on
 * `owned` rather than `!== 'registry'` for that reason: a future third kind whose prefix arm is
 * likewise unanchored would ride a deny-list in silently, with no type error. Stays in step with
 * `dynamicMembershipScopesFor` (apps/client/server/dataLakes/index.ts), the same allow-list on the
 * browse fan-out.
 *
 * Single-lake consumers do NOT filter: a query covering exactly one access-gated lake is where an
 * unanchored prefix arm is safe, and narrowing a registry lake out there is what under-counted it.
 * See `knowledgeBaseCount`'s `lakeScope` and the articles route.
 *
 * The optional read is not a live state - `membership` is required - it is the direction this
 * degrades if some loosely-typed producer ever hands over a partial lake: contribute NO arm, i.e.
 * match less. The count surface deliberately does the opposite and throws, because there a missing
 * scope would silently report a wrong NUMBER; here it can only narrow a search.
 */
export const lakeMembershipsFrom = (lakes: ResolvedLakeAccess[]): DataLakeMembershipScope[] =>
  lakes.flatMap(l => (l.membership?.kind === 'owned' ? [l.membership] : []));

/** Above this many per-lake `$or` arms, subplanning cost may start to show in latency (R3). */
const LARGE_MEMBERSHIP_ARM_COUNT = 50;

/**
 * R3: surface a large per-caller membership-arm count in logs before it shows up in latency.
 * Ship without a cap - a caller legitimately reaching this many lakes still gets every one of them;
 * this only makes the regime visible. Call once per retrieval-call-site query, right after
 * `lakeMembershipsFrom`.
 */
export const warnIfManyLakeMemberships = (
  memberships: DataLakeMembershipScope[],
  logger: Logger | undefined,
  surface: string
): void => {
  if (memberships.length > LARGE_MEMBERSHIP_ARM_COUNT) {
    logger?.warn(
      `[dataLakes] ${surface}: retrieval query carries ${memberships.length} lake membership arms ` +
        `(> ${LARGE_MEMBERSHIP_ARM_COUNT}) - watch for subplanning cost showing up in latency`
    );
  }
};

/**
 * Fetches dynamic data lake configs from DB (if available) and returns
 * the merged datalake: tags for the user.
 *
 * Tags-only convenience wrapper over getDynamicDataLakeAccess below. Currently has no
 * production callers - every retrieval surface needs the prefixes too and calls the full
 * resolver directly. Kept as part of the package's public surface.
 */
export async function getDynamicDataLakeTags(context: DataLakeAccessContext): Promise<string[]> {
  return (await getDynamicDataLakeAccess(context)).dataLakeTags;
}

/**
 * Returns BOTH the meta-tags AND the file tag prefixes for a user's accessible data lakes.
 * Use this for fabfiles.search() so files are matched by either the datalake:* meta-tag
 * (when present) OR by their content tag prefix (e.g. opti:*, acme:*) - many data lake
 * files don't have the meta-tag but do have the prefix-based content tags.
 *
 * Access is entitlement-aware: lakes are matched against the user's tags AND resolved
 * entitlement keys (any-of declared requirements), so an entitlement-gated lake resolves
 * for a tag-less subscriber. The same `entitlementKeys` flow to BOTH the DB pre-filter and
 * the in-memory filter so the meta-tag set and the prefix set stay consistent.
 *
 * The DB pre-filter's owner bypass is honoured too: a lake the caller created resolves even
 * when they do not hold its own declared gate. Ownership is re-verified here against the
 * persisted `createdByUserId` rather than assumed from the query, and stays bounded by the
 * pre-filter's `status: 'active'`, so a caller's own DRAFT lake remains browse-only. The
 * bypass is org-independent, matching browse: a creator who has since moved orgs still reaches
 * a gated lake they made in the old one, and only they or an admin could have put files in it.
 *
 * Persisted access GRANTS are honoured on the same terms browse honours them (`grantedLakeReachFor`),
 * when a grant repo is wired: the grant row IS the authorization, so a granted lake bypasses the
 * org and gate constraints and is restored past the in-memory filter exactly as an owner's own
 * gated lake is. Nothing downstream changes - a lake's file-membership predicate is anchored to
 * the lake's CREATOR, not the caller, so a granted lake's files match the moment the lake is in
 * this set.
 */
export async function getDynamicDataLakeAccess(context: DataLakeAccessContext): Promise<{
  dataLakeTags: string[];
  dataLakeTagPrefixes: string[];
  scopedTagPrefixes: string[];
  lakes: ResolvedLakeAccess[];
  /**
   * How many active lakes the caller can see exist - by org membership or public listing - but
   * whose own `requiredUserTag`/`requiredEntitlement` gate they hold neither of (#3055). From a
   * dedicated count-only query (`countGateExcludedLakes`), NOT derived from the candidate set
   * fetched below: that set's non-owner arms already enforce the gate in Mongo
   * (`requirementConstraint`), so a lake the caller's org can see but lacks the entitlement for is
   * never among `dbLakes` at all - a diff against it would count almost nothing real. Excludes
   * lakes reached via the owner or grant bypass, which are never "excluded" regardless of the
   * gate.
   *
   * OPTIONAL, same reason and same contract as `lakeViewComplete` below: a failed or unwired count
   * query means "not measured", never a false "nothing excluded". A rebuild that forgets this
   * field degrades to "say nothing", which is the safe direction - there is no safe default number
   * (0 would under-report a real outage as a clean turn).
   *
   * "Not measured" also covers a failed entitlement lookup, enforce-flag read, grant-exemption
   * read, or supersession read upstream of the count (#3055, #3155) - all four are inputs the
   * count trusts, so a degraded input produces a confidently WRONG number rather than an honest
   * failure; see `excludedByAccessCountPrerequisitesComplete` at this function's call site for the
   * four failure directions this guards against.
   */
  excludedByAccessCount?: number;
  /**
   * True when the dynamic-lake read either succeeded or was never configured. False when it failed
   * and the sets below are the static registry alone.
   *
   * Precisely: it records that THIS RESOLVER saw everything it was asked to see. It is not a claim
   * that the lists are exhaustive of the caller's access forever after - a later transform may
   * deliberately reduce them (narrowLakeAccessToSession) while carrying the flag - so a consumer
   * that treats it as "this list is complete" must be reading the resolver's own output, not a
   * derived one.
   *
   * Exists because "this lake is not in your access" and "I could not see your lakes just now" are
   * indistinguishable in the tag lists, and one consumer must tell them apart: a caller that treats
   * an absent tag as proof of unreachability will discard a correct scope during a read failure.
   * See the intersection in sessionService/deriveRetrievalTags.
   *
   * OPTIONAL, and consumers must require a positive `true` to treat the view as authoritative - so
   * a transform that rebuilds this object and forgets the field degrades to "do not narrow", which
   * is the safe direction. Both known rebuild sites preserve it deliberately
   * (narrowLakeAccessToSession, resolveRetrievalLakeScope's withStaticRegistryBypass).
   */
  lakeViewComplete?: boolean;
}> {
  const userTags = context.user.tags || [];
  const entitlementKeys = context.entitlementKeys ?? [];
  const userId = context.user.id ? String(context.user.id) : undefined;
  // #3055: unknown (never a false 0) until the count-only query below actually runs and
  // succeeds - see excludedByAccessCount's own doc on the return type for why absence must
  // mean "not measured", the same contract lakeViewComplete keeps for the rest of this function.
  let excludedByAccessCount: number | undefined;
  let dynamicDataLakes: DataLakeConfig[] | undefined;
  // Ids of fetched lakes whose PERSISTED createdByUserId is this caller. Read off the raw
  // documents because toDataLakeConfig drops createdByUserId - and that projection is also what
  // GET /api/data-lakes serializes to the browser, so the field must not be widened into
  // DataLakeConfig just to reach it here. Declared const and filled in place: it can only gain
  // members inside the try below, so an absent repo or a failed read leave it empty by
  // construction rather than by a reader's reasoning.
  const ownedDynamicIds = new Set<string>();
  // Same role as ownedDynamicIds, for the grant rung: ids the caller reaches by a persisted grant
  // rather than by the lake's own gate. Filled only from the resolved grant set, so an absent or
  // failing grant repo leaves it empty by construction.
  const grantedDynamicIds = new Set<string>();
  // Complete unless the read below throws. An absent `db.dataLakes` is NOT degraded: a deployment
  // with no dynamic-lake repo has no dynamic lakes to miss, so its registry-only answer is whole.
  let lakeViewComplete = true;
  // Same reason as ownedDynamicIds: createdByUserId survives only on the raw documents, and
  // whole-lake queries (see ResolvedLakeAccess) cannot anchor a prefix arm without it.
  const creatorByDynamicId = new Map<string, string>();
  // Lakes the caller created but no longer effectively owns. Used TWICE below and both uses are
  // load-bearing: it narrows the repo's creator arm, and it narrows `ownedDynamicIds` so the
  // in-memory restoration cannot put back a gated lake the narrowed query correctly withheld.
  // DEGRADES OPEN (stays empty) when the grant read fails or no grant repo is wired, matching
  // `supersededOwnLakeIdsFor` - the floor is then today's behavior, never worse.
  let supersededOwnLakeIds = new Set<string>();
  // Tracks the exclusion COUNT's own prerequisites separately from `lakeViewComplete` above,
  // because the two flags gate opposite failure directions for the same reads (#3055). A failed
  // grant-exemption read degrading `reach` to empty makes the count OVER-count (a lake actually
  // exempted by a grant now looks excluded); a failed supersession read degrading
  // `supersededOwnLakeIds` to empty makes it UNDER-count (a lake that should have lost its
  // owner-bypass exemption still gets one). `lakeViewComplete` only tracks the first direction
  // (matching its own "lakes may be MISSING" contract) and is deliberately left untouched by the
  // second (see the supersession catch below) - so neither flag alone can gate the count safely.
  // Stays `true` when a read is simply unwired (no grant repo): an absent adapter has nothing to
  // fail, so `reach`/`supersededOwnLakeIds` staying at their empty defaults is a complete answer,
  // not a degraded one.
  //
  // Seeded from the caller's own entitlement-read completeness (#3155): a thrown entitlement lookup
  // degrades `context.entitlementKeys` to `[]` before this function ever sees it, which would
  // otherwise make an entitlement-gated lake look gate-excluded for a caller whose real keys are
  // simply unknown this turn. UNLIKE the grant/supersession pair above, this ALSO sets
  // `lakeViewComplete = false`: `entitlementKeys` is not just a count input, it is the same array
  // handed to `findActiveByUserTagsAndEntitlements` below - so a degraded `[]` can silently drop an
  // entitlement-gated lake the caller genuinely holds the key for out of `dataLakeTags`/`lakes`
  // too, exactly the "lakes may be MISSING" failure `lakeViewComplete` exists to flag.
  lakeViewComplete = context.entitlementKeysResolved !== false;
  let excludedByAccessCountPrerequisitesComplete = lakeViewComplete;
  if (!excludedByAccessCountPrerequisitesComplete) {
    context.logger?.warn(
      '[dataLakes] gate-excluded-lake count prerequisite incomplete: entitlement lookup failed this turn'
    );
  }
  if (context.db.dataLakes) {
    // Fail closed on the projected reader rather than a bare TypeError: an unwired host gets a
    // legible error naming the missing adapter. Resolved only on this branch - a static-registry-
    // only caller (no dataLakes repo) never consumes membership, so it must not pay for, or be
    // able to throw on, a lookup whose result it can't use (a static-only caller previously ran
    // this lookup unconditionally).
    if (typeof context.db.organizations?.findMembershipOrgIds !== 'function') {
      throw new Error(
        'getDynamicDataLakeAccess: context.db.organizations.findMembershipOrgIds is required to resolve lake access'
      );
    }
    // Authoritative membership (owner + users[] ACL), resolved here so every construction site
    // of this context - the chat tools, the retrieval scope, semantic search - cannot disagree
    // about what "my orgs" means (#1674). Id-less callers are members of nothing.
    //
    // Resolved outside the try/catch below on purpose: within THIS resolver, a transient failure
    // here propagates rather than being silently folded into "member of nothing" by the dataLakes
    // fail-safe below. That guarantee is local to this function - top-level chat callers
    // (ChatCompletionProcess.getAccessibleDataLakeAccess, ChatCompletionFeatures) may still catch
    // this throw and degrade to an empty scope, which is ALSO fail-closed (it denies, never
    // grants). So the placement buys observability into where a failure originated, not a
    // stronger deny guarantee than returning [] outright would have given.
    // Memoized per turn (this resolver runs per TOOL CALL), sharing one entry with the injection
    // resolver - see membershipOrgIdsForTurn. The propagate-not-swallow placement above still holds:
    // the memo evicts a rejection rather than caching it as "member of nothing".
    const organizationIds = userId ? await membershipOrgIdsForTurn(context, userId, context.db.organizations) : [];
    // The grant rung, resolved on the SAME terms as browse (`grantedLakeReachFor`) so the two halves
    // of the access model cannot drift: owner/curator always, reader + org principals only under
    // the enforced cutover. Failing closed to no grants rather than propagating - a grant lookup
    // that cannot be read must narrow retrieval, never throw a whole chat turn away.
    let reach: LakeGrantReach = { grantedLakeIds: [], orgGrantedLakes: {} };
    if (userId && context.db.dataLakeAccessGrants) {
      try {
        const { enforced: includeReaders, readSucceeded } = await resolveEnforceReadGrantsResult(
          context.db.adminSettings,
          context.logger,
          context
        );
        if (!readSucceeded) {
          // The enforce-flag read itself failed and degraded to report-only (#3155): `includeReaders`
          // is `false` but not TRUSTWORTHY-false, so `reach` below narrows (reader/org grants excluded)
          // exactly like the failed-grants-read catch just below - same two consequences, same
          // reasons: the lake view may be missing a grant-only lake, and the exclusion count would
          // over-count a lake actually exempted by that grant.
          context.logger?.warn(
            '[dataLakes] enforce-flag read failed; resolving lakes without the reader/org grant rungs'
          );
          lakeViewComplete = false;
          excludedByAccessCountPrerequisitesComplete = false;
        }
        reach = await grantedLakeReachForTurn(
          context,
          userId,
          organizationIds,
          context.db.dataLakeAccessGrants,
          includeReaders
        );
      } catch (err) {
        // Same fail-closed contract as the dataLakes read below: a failed grants read narrows the
        // view (the grant arm contributes nothing) and must SAY so, or a consumer would read the
        // resulting absence as proof of unreachability. See lakeViewComplete.
        context.logger?.warn('[dataLakes] access-grant lookup failed; resolving lakes without the grant arm', err);
        lakeViewComplete = false;
        // Also a count prerequisite (#3055): `reach` just fell back to empty, so a lake actually
        // exempted by that grant would otherwise be miscounted as excluded below.
        excludedByAccessCountPrerequisitesComplete = false;
      }
      // The other half of the same access model: `findActiveByUserTagsAndEntitlements`'s creator arm
      // is bare provenance, and `createdByUserId` is immutable, so a creator transferred or departed
      // off a lake keeps GROUNDING on it long after browse stopped listing it. Same
      // `userId && dataLakeAccessGrants` guard as the reach - with no grant repo nothing can
      // supersede anyone - but deliberately NOT the same try: a failure here widens the view rather
      // than narrowing it, so it owes a different warning and must NOT set `lakeViewComplete`, which
      // means "lakes may be MISSING" and is what consumers read to refuse an unreachability verdict.
      //
      // NOT gated on `includeReaders`: an owner-role grant is what moves ownership, and it is
      // honored on both sides of the cutover (`grantedLakeReachFor` admits owner/curator
      // unconditionally too). `isAdmin: false` is deliberate rather than a stub - this resolver has
      // no admin bypass by design (see the header), so an admin's creator arm narrows like anyone's.
      try {
        supersededOwnLakeIds = new Set(
          await supersededOwnLakeIdsForTurn(
            context,
            { userId, isAdmin: false },
            context.db.dataLakes,
            context.db.dataLakeAccessGrants
          )
        );
      } catch (err) {
        // Degrades OPEN: the creator arm stays at bare provenance, which is exactly today's
        // behavior, never worse. Logged because it is the only trace - an unread failure here is
        // indistinguishable from "this caller has been superseded on nothing".
        context.logger?.warn(
          '[dataLakes] ownership-supersession lookup failed; creator arm left at bare provenance',
          err
        );
        // Also a count prerequisite (#3055), in the OPPOSITE direction from the grant-read catch
        // above: `supersededOwnLakeIds` just fell back to empty, so a lake that should have LOST
        // its owner-bypass exemption would otherwise be miscounted as NOT excluded below.
        excludedByAccessCountPrerequisitesComplete = false;
      }
    }
    // The repo silently drops an unusable dataLakeId from its `_id` arms instead of failing, so a
    // bad grant makes its lake vanish while the read reports success - the same partial view as the
    // failed-read path above, and it owes consumers the same admission. Re-checked here (not just
    // in the repo) so the warn carries the request logger.
    const reachIds = [...reach.grantedLakeIds, ...Object.values(reach.orgGrantedLakes).flat()];
    const usableReachIds = usableObjectIds(reachIds, 'getDynamicDataLakeAccess.reach', context.logger);
    if (usableReachIds.length !== reachIds.length) {
      lakeViewComplete = false;
      context.logger?.warn('[lake-grant-guard] lake view incomplete: unusable grant id dropped', {
        received: reachIds.length,
        usable: usableReachIds.length,
        dropped: reachIds.length - usableReachIds.length,
      });
    }
    try {
      const dbLakes = await context.db.dataLakes.findActiveByUserTagsAndEntitlements(
        userTags,
        entitlementKeys,
        organizationIds,
        userId,
        { ...reach, supersededOwnLakeIds: [...supersededOwnLakeIds] }
      );
      dynamicDataLakes = dbLakes.map(toDataLakeConfig);
      for (const dl of dbLakes) {
        if (dl.createdByUserId) creatorByDynamicId.set(dl.id, String(dl.createdByUserId));
      }
      // Only the document side is coerced. `userId` is already a string or undefined, so an
      // id-less caller can never match: leave it uncoerced. Wrapping it too would compare the
      // literal 'undefined' and hand every lake whose creator is the string 'undefined' - a
      // plausible bad-ingest value - to every anonymous caller. The `if` is a cheap
      // short-circuit, not the guard.
      if (userId) {
        for (const dl of dbLakes) {
          // The supersession check is not redundant with the query's: this set drives the
          // `ownedGatedLakes` restoration below, which deliberately RE-ADMITS a lake the pure
          // tag/entitlement predicate dropped. Without it the query narrowing would be undone in
          // memory for exactly the gated lakes that most need it.
          if (String(dl.createdByUserId) === userId && !supersededOwnLakeIds.has(dl.id)) {
            ownedDynamicIds.add(dl.id);
          }
        }
      }
      // Intersected with what the query actually returned, so a stale grant naming a deleted or
      // archived lake cannot put an id into the restoration set below.
      const grantedIdSet = new Set(reachIds);
      for (const dl of dbLakes) {
        if (grantedIdSet.has(dl.id)) grantedDynamicIds.add(dl.id);
      }
    } catch (err) {
      // Degrading to the static registry silently looks exactly like "this deployment has no
      // dynamic lakes", so a read failure would quietly restore the pre-unification behavior.
      // Still non-fatal: the collection may simply not exist yet.
      context.logger?.warn('[dataLakes] dynamic lake lookup failed; falling back to the static registry', err);
      // The warn above is the only other trace of this, and it is dropped when no logger is passed.
      // This flag is what lets a consumer act on the degradation instead of misreading it as access.
      lakeViewComplete = false;
    }
    // #3055: a separate COUNT-ONLY query (never returns a lake document - see
    // countGateExcludedLakes's own doc), because the candidate set fetched above cannot answer
    // this. Its non-owner arms already enforce the gate in Mongo (requirementConstraint), so a
    // lake the caller's org can see but lacks the entitlement for is never among `dbLakes` at
    // all - diffing that set against `resolvedLakes` would count almost nothing real. Degrades to
    // `undefined` (unknown), never `0`, on any failure - a caller must not read "no access issue"
    // from a query that could not run. Guarded separately from the block above: a host that wired
    // `findActiveByUserTagsAndEntitlements` but not this newer method must not lose lake access
    // entirely over one missing capability.
    // A complete `reach`/`supersededOwnLakeIds` is a prerequisite for a TRUSTWORTHY count, not just
    // a successful query - see `excludedByAccessCountPrerequisitesComplete`'s own doc for why
    // running the count on a degraded input would produce a confidently wrong number in either
    // direction rather than the honest "unknown" this field's contract requires.
    if (excludedByAccessCountPrerequisitesComplete) {
      try {
        excludedByAccessCount = await context.db.dataLakes.countGateExcludedLakes(
          userTags,
          entitlementKeys,
          organizationIds,
          userId,
          // supersededOwnLakeIds (#3055): withholds the owner-bypass exemption from a lake
          // whose ownership has since moved off the caller - see countGateExcludedLakes's own doc.
          { ...reach, supersededOwnLakeIds: [...supersededOwnLakeIds] }
        );
      } catch (err) {
        context.logger?.warn('[dataLakes] gate-excluded-lake count failed; reporting as unknown', err);
      }
    } else {
      context.logger?.warn(
        '[dataLakes] gate-excluded-lake count skipped; an entitlement, enforce-flag, grant-exemption, ' +
          'or supersession prerequisite read failed this turn'
      );
    }
  }
  const accessibleLakes = getAccessibleDataLakes(userTags, dynamicDataLakes, entitlementKeys);
  // getAccessibleDataLakes is a pure tag/entitlement predicate with no ownership rule (by
  // design - its docstring tells callers to pre-filter), so on its own it discards a lake the
  // caller CREATED whose own gate they do not hold. The DB arm returned that lake via
  // `{ createdByUserId: userId }`; this puts it back.
  //
  // Do NOT reduce this to "the DB returned it, so the owner arm must have matched". The
  // in-memory pass is an independent second opinion whose job is to drop what an over-returning
  // query should not have handed us, so a NON-owned gated lake must still fall out even with a
  // userId present. That is why ownership is re-derived above from the persisted field.
  //
  // Every set below derives from this union, so the provenance split and the reserved-tag drop
  // apply to re-added lakes too.
  //
  // Restoring also requires the row to be well-formed: its meta-tag must be the one its own
  // slug/org would mint. Before this exemption a malformed row was dropped twice - by the gate
  // filter AND by the reserved-tag check - and the reserved-tag check knows only the registry
  // this runtime can see (the premium half arrives through an env seam). Requiring
  // self-consistency keeps a second, environment-independent check on the privileged path.
  const accessibleIds = new Set(accessibleLakes.map(dl => dl.id));
  const ownedGatedLakes = (dynamicDataLakes ?? []).filter(
    dl => ownedDynamicIds.has(dl.id) && !accessibleIds.has(dl.id) && isDatalakeTagWellFormed(dl)
  );
  // Same restoration, same reasons, for the grant rung: a grant IS the authorization, so a lake
  // whose own gate the caller does not hold must survive the pure tag/entitlement predicate. The
  // well-formedness guard is carried over verbatim - a privileged path may not re-admit a row
  // whose meta-tag is not the one its own slug/org would mint.
  const grantedGatedLakes = (dynamicDataLakes ?? []).filter(
    dl =>
      grantedDynamicIds.has(dl.id) &&
      !ownedDynamicIds.has(dl.id) &&
      !accessibleIds.has(dl.id) &&
      isDatalakeTagWellFormed(dl)
  );
  const resolvedLakes = [...accessibleLakes, ...ownedGatedLakes, ...grantedGatedLakes];
  // Split prefixes by provenance: static-registry lakes are OPEN (shared KB - ownership
  // bypass by design); dynamic (DB) lakes are SCOPED (their user-controlled prefix must be
  // matched ONLY within owner/org access, else a colliding prefix leaks another tenant's
  // files). A lake is dynamic iff it came from the DB set - deliberately NOT
  // `openLakeTagPrefix`/`STATIC_LAKE_IDS` (@bike4mind/common), which classify by id membership in
  // the hardcoded registry instead of by source. Those two answers usually agree, but a DB row can
  // shadow a registry id (see `isShadowedRegistryTag` below and `resolveDataLakeAccess`'s "DB takes
  // precedence" rule) - a shadowed row must stay SCOPED, which only the source-based check gets
  // right; `STATIC_LAKE_IDS.has(dl.id)` would wrongly call it OPEN and turn its user-controlled
  // prefix into an ownership-bypassing grant. Do not swap this for the shared helper.
  const dynamicIds = new Set((dynamicDataLakes ?? []).map(d => d.id));
  // The meta-tag arm is an ownership bypass, safe only because a lake's datalakeTag is
  // globally unique. A DB row can still carry a tag the static registry owns (the registry
  // has no documents, so the unique index never saw the collision), and that row would hand
  // its creator every tenant's files in the registry lake. createDataLake now refuses to mint
  // such a tag; this drops any row that predates that guard or was written around it.
  const reservedTags = new Set(DATA_LAKES.map(lake => lake.datalakeTag));
  const isShadowedRegistryTag = (dl: DataLakeConfig) => dynamicIds.has(dl.id) && reservedTags.has(dl.datalakeTag);
  return {
    lakeViewComplete,
    excludedByAccessCount,
    dataLakeTags: resolvedLakes.filter(dl => !isShadowedRegistryTag(dl)).map(dl => dl.datalakeTag),
    dataLakeTagPrefixes: resolvedLakes.filter(dl => !dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
    scopedTagPrefixes: resolvedLakes.filter(dl => dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
    // A shadowed row is dropped outright rather than degraded: its tag belongs to a registry
    // lake, so any whole-lake query built from it would run against the wrong corpus.
    lakes: resolvedLakes
      .filter(dl => !isShadowedRegistryTag(dl))
      .map(dl => {
        const isDynamic = dynamicIds.has(dl.id);
        const creatorUserId = isDynamic ? (creatorByDynamicId.get(dl.id) ?? '') : '';
        // `createdByUserId` is `required: true` on the persisted lake, so an empty value here is a
        // legacy row or a bad ingest, not a normal state (R8). Fail-closed to meta-tag-only matching
        // is still the right behavior (see buildDataLakeMembershipFilter) - this just makes the
        // silent under-retrieval visible so an operator can backfill it.
        if (isDynamic && !creatorUserId) {
          context.logger?.warn(
            `[dataLakes] dynamic lake "${dl.id}" (${dl.datalakeTag}) resolved with no creator - its ` +
              'prefix-only members will retrieve/count as meta-tag-only for every caller until backfilled'
          );
        }
        return {
          id: dl.id,
          name: dl.name,
          slug: dl.slug,
          datalakeTag: dl.datalakeTag,
          fileTagPrefix: dl.fileTagPrefix,
          // Both kinds get a scope, so no whole-lake consumer has to hand-roll a registry
          // fallback. A creator-less DB row fails closed to meta-tag-only matching inside the
          // filter builder, which is the safe direction (see buildDataLakeMembershipFilter); a
          // registry lake's arm is unanchored by design and is dropped from multi-lake retrieval
          // queries by `lakeMembershipsFrom`, not by being left absent here.
          membership: isDynamic
            ? lakeMembershipScope({
                datalakeTag: dl.datalakeTag,
                fileTagPrefix: dl.fileTagPrefix,
                createdByUserId: creatorUserId,
              })
            : registryMembershipScope(dl),
          source: isDynamic ? ('dynamic' as const) : ('registry' as const),
        };
      }),
  };
}

/**
 * #3055 (scope-accounting follow-up): how many of the SPECIFIC lakes a session names by
 * IDENTITY tag (`datalake:x`, e.g. from `datalakeTagsFrom(session.retrievalTags)`) are
 * gate-excluded for this caller - the per-turn-scoped sibling of `excludedByAccessCount`
 * above, for exactly the case that function's own account-wide count cannot answer.
 *
 * Why a separate function rather than teaching `narrowLakeAccessToSession` this: that
 * function is a pure, synchronous filter reused by callers with no DB access, and it must
 * stay that way (see its own doc). This runs the same targeted `countGateExcludedLakes`
 * query `getDynamicDataLakeAccess` already runs, restricted to `identityTags` via
 * `restrictToTags`, so it answers "of exactly these lakes, how many are excluded" instead of
 * "how many are excluded account-wide" - the two diverge exactly when a session narrows to
 * one lake while an unrelated lake is what's actually gated.
 *
 * Reuses the SAME per-turn-memoized organizationIds/grant-reach/supersession as
 * `getDynamicDataLakeAccess` (both are keyed on the identity of `context`), so calling this
 * after that resolver already ran for the turn costs one extra count query, not a second
 * membership or grant read - PROVIDED the caller passes the SAME `context` object both times
 * (#3055 review). A caller that builds a fresh object per call defeats this silently: the memos
 * miss on identity, not on field equality, and the two reads can then observe different
 * snapshots. See `ChatCompletionProcess.getDataLakeAccessContext` for the one production caller
 * that holds this invariant.
 *
 * Returns 0 without a query for an empty `identityTags` list - nothing was named by
 * identity, so nothing can be excluded by identity (a session can only reference an
 * inaccessible lake by its identity tag; a prefix reference is only ever matched against
 * lakes the caller can already see, per `narrowLakeAccessToSession`). Returns `undefined`
 * (not measured), never a false 0, on any failure or when the dataLakes repo or the
 * organizations reader is unwired - same absence contract as `excludedByAccessCount`.
 * Deliberately a single top-level try/catch rather than per-arm degradation like the main
 * resolver above: this is a narrower, telemetry-only path (it never gates real retrieval),
 * so "any failure means unknown" is the simpler and equally safe contract.
 */
export async function measureIdentityNamedExclusion(
  context: DataLakeAccessContext,
  identityTags: string[]
): Promise<number | undefined> {
  if (identityTags.length === 0) return 0;
  if (!context.db.dataLakes || typeof context.db.organizations?.findMembershipOrgIds !== 'function') {
    return undefined;
  }
  // #3155: the entitlement lookup that produced `context.entitlementKeys` may itself have failed
  // (see `entitlementKeysResolved`'s own doc) - this function's "any failure means unknown" contract
  // extends to that upstream failure too, since a degraded key list would make an entitlement-gated
  // lake look excluded rather than unmeasured.
  if (context.entitlementKeysResolved === false) {
    context.logger?.warn('[dataLakes] scoped gate-excluded-lake count skipped; entitlement lookup failed this turn');
    return undefined;
  }
  const userTags = context.user.tags || [];
  const entitlementKeys = context.entitlementKeys ?? [];
  const userId = context.user.id ? String(context.user.id) : undefined;
  try {
    const organizationIds = userId ? await membershipOrgIdsForTurn(context, userId, context.db.organizations) : [];
    let reach: LakeGrantReach = { grantedLakeIds: [], orgGrantedLakes: {} };
    let supersededOwnLakeIds = new Set<string>();
    if (userId && context.db.dataLakeAccessGrants) {
      const { enforced: includeReaders, readSucceeded } = await resolveEnforceReadGrantsResult(
        context.db.adminSettings,
        context.logger,
        context
      );
      if (!readSucceeded) {
        // Same reasoning as the account-wide resolver's own enforce-flag check: a failed read
        // degrades to report-only and narrows `reach`, which would over-count this identity-scoped
        // exclusion - so the whole measurement is unknown, not partial (#3155).
        context.logger?.warn('[dataLakes] scoped gate-excluded-lake count skipped; enforce-flag read failed this turn');
        return undefined;
      }
      reach = await grantedLakeReachForTurn(
        context,
        userId,
        organizationIds,
        context.db.dataLakeAccessGrants,
        includeReaders
      );
      supersededOwnLakeIds = new Set(
        await supersededOwnLakeIdsForTurn(
          context,
          { userId, isAdmin: false },
          context.db.dataLakes,
          context.db.dataLakeAccessGrants
        )
      );
    }
    return await context.db.dataLakes.countGateExcludedLakes(userTags, entitlementKeys, organizationIds, userId, {
      ...reach,
      supersededOwnLakeIds: [...supersededOwnLakeIds],
      restrictToTags: identityTags,
    });
  } catch (err) {
    context.logger?.warn('[dataLakes] scoped gate-excluded-lake count failed; reporting as unknown', err);
    return undefined;
  }
}
