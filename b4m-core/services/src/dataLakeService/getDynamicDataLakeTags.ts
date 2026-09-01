import {
  DATA_LAKES,
  DataLakeConfig,
  getAccessibleDataLakes,
  toDataLakeConfig,
  type DataLakeMembershipScope,
  type IDataLakeRepository,
  type IFallbackLakeSettingsRepository,
  type IOrganizationRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { isDatalakeTagWellFormed } from './createDataLake';
import { lakeMembershipScope } from './lakeMembershipScope';

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
    dataLakes?: Pick<IDataLakeRepository, 'findActiveByUserTags' | 'findActiveByUserTagsAndEntitlements'>;
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
  /** Optional; only used to report a swallowed dataLakes read failure (see below). */
  logger?: Logger;
}

/**
 * One accessible lake, resolved far enough to run a WHOLE-LAKE query against it (counting,
 * stats) rather than only a tag-matched search. Exists because the tag/prefix sets below are
 * flattened unions: they answer "may this file be searched" but lose which lake a file belongs
 * to, the creator its prefix arm is anchored to, and the lake's product-facing name.
 *
 * `source` is load-bearing, not decoration. A registry lake's files carry only prefixed content
 * tags - no write path stamps its meta-tag - so a membership-scope count of one returns 0; it
 * has to be counted through the OPEN prefix arm instead. See lakeMembershipScope and the
 * articles route's `isFallback` branch, which this must stay in agreement with.
 */
export interface ResolvedLakeAccess {
  id: string;
  name: string;
  slug: string;
  datalakeTag: string;
  fileTagPrefix: string;
  /**
   * The whole-lake membership predicate, DB lakes only - the same scope the single-lake browse
   * and every lifecycle write run on, so a count built from it equals the lake page's total.
   * Absent for registry lakes: they have no creator to anchor the prefix arm to.
   */
  membership?: DataLakeMembershipScope;
  source: 'registry' | 'dynamic';
}

/**
 * The membership arms a retrieval query should carry for a resolved access set: one per lake that
 * HAS a membership scope. Registry lakes have none (no creator to anchor to) and keep using the
 * OPEN `dataLakeTagPrefixes` arm - dropping them here is what stops a registry lake being silently
 * demoted to meta-tag-only matching.
 *
 * INVARIANT: every scope this returns is creator-anchored to a DYNAMIC lake. Two independent
 * guards hold it, because presence alone is no longer enough: `membership` is set ONLY on the
 * `source: 'dynamic'` branch below, AND the `kind` filter here drops a registry scope even if some
 * future construction site attaches one. #2216 gave `DataLakeMembershipScope` that discriminant
 * precisely so this could be checked - a registry scope's prefix arm carries no ownership conjunct
 * (see `buildDataLakeMembershipFilter`), so letting one reach a retrieval query would reopen the
 * cross-tenant promotion the SCOPED/OPEN split exists to forbid. Registry lakes keep using the
 * OPEN `dataLakeTagPrefixes` arm instead.
 */
export const lakeMembershipsFrom = (lakes: ResolvedLakeAccess[]): DataLakeMembershipScope[] =>
  lakes.flatMap(l => (l.membership && l.membership.kind !== 'registry' ? [l.membership] : []));

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
 */
export async function getDynamicDataLakeAccess(context: DataLakeAccessContext): Promise<{
  dataLakeTags: string[];
  dataLakeTagPrefixes: string[];
  scopedTagPrefixes: string[];
  lakes: ResolvedLakeAccess[];
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
  let dynamicDataLakes: DataLakeConfig[] | undefined;
  // Ids of fetched lakes whose PERSISTED createdByUserId is this caller. Read off the raw
  // documents because toDataLakeConfig drops createdByUserId - and that projection is also what
  // GET /api/data-lakes serializes to the browser, so the field must not be widened into
  // DataLakeConfig just to reach it here. Declared const and filled in place: it can only gain
  // members inside the try below, so an absent repo or a failed read leave it empty by
  // construction rather than by a reader's reasoning.
  const ownedDynamicIds = new Set<string>();
  // Complete unless the read below throws. An absent `db.dataLakes` is NOT degraded: a deployment
  // with no dynamic-lake repo has no dynamic lakes to miss, so its registry-only answer is whole.
  let lakeViewComplete = true;
  // Same reason as ownedDynamicIds: createdByUserId survives only on the raw documents, and
  // whole-lake queries (see ResolvedLakeAccess) cannot anchor a prefix arm without it.
  const creatorByDynamicId = new Map<string, string>();
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
    const organizationIds = userId ? await context.db.organizations.findMembershipOrgIds(userId) : [];
    try {
      const dbLakes = await context.db.dataLakes.findActiveByUserTagsAndEntitlements(
        userTags,
        entitlementKeys,
        organizationIds,
        userId
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
          if (String(dl.createdByUserId) === userId) ownedDynamicIds.add(dl.id);
        }
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
  const resolvedLakes = [...accessibleLakes, ...ownedGatedLakes];
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
    dataLakeTags: resolvedLakes.filter(dl => !isShadowedRegistryTag(dl)).map(dl => dl.datalakeTag),
    dataLakeTagPrefixes: resolvedLakes.filter(dl => !dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
    scopedTagPrefixes: resolvedLakes.filter(dl => dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
    // A shadowed row is dropped outright rather than degraded: its tag belongs to a registry
    // lake, so any whole-lake query built from it would run against the wrong corpus.
    lakes: resolvedLakes
      .filter(dl => !isShadowedRegistryTag(dl))
      .map(dl => {
        const isDynamic = dynamicIds.has(dl.id);
        return {
          id: dl.id,
          name: dl.name,
          slug: dl.slug,
          datalakeTag: dl.datalakeTag,
          fileTagPrefix: dl.fileTagPrefix,
          // A creator-less row fails closed to meta-tag-only matching inside the filter builder,
          // which is the safe direction (see buildDataLakeMembershipFilter).
          ...(isDynamic
            ? {
                membership: lakeMembershipScope({
                  datalakeTag: dl.datalakeTag,
                  fileTagPrefix: dl.fileTagPrefix,
                  createdByUserId: creatorByDynamicId.get(dl.id) ?? '',
                }),
              }
            : {}),
          source: isDynamic ? ('dynamic' as const) : ('registry' as const),
        };
      }),
  };
}
