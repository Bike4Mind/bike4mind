/**
 * Lake-scope resolution for the RETRIEVAL surfaces (vector/semantic search).
 *
 * Distinct from `resolveAccessibleLakes` in ./index.ts, which serves the BROWSE surfaces
 * (articles, tag-counts, the rlm-answer access gate) and returns whole lake configs. This
 * one returns the tag/prefix triple the search primitive consumes, and it delegates to
 * `getDynamicDataLakeAccess` - the SAME core function the chat `search_knowledge_base` tool
 * calls - so a caller's semantic-search scope and their chat-retrieval scope cannot drift.
 *
 * Browse stays the wider of the two - see the difference list in ./index.ts (admin reach;
 * draft lakes). Retrieval is a subset in every case, never the reverse. Do not paper those
 * over here. An owner's own gated lake is no longer among them: the core resolver restores it.
 */
import { DATA_LAKES, hasDeveloperUserTag, type DataLakeConfig } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, organizationRepository } from '@bike4mind/database';
import { getRequestEntitlements, getUserEntitlements, type EntitlementRequest } from '@server/entitlements';
import type { Logger } from '@bike4mind/observability';
import { getRequestMembershipOrgIds, type MembershipRequest } from './requestMembership';

/** EntitlementRequest carries no logger; the routes calling this are Express requests that do. */
type RetrievalScopeRequest = EntitlementRequest & MembershipRequest & { logger?: Logger };

/** The tag/prefix triple `semanticDataLakeSearch` scopes on. Mirrors the core resolver's return. */
export type RetrievalLakeScope = Awaited<ReturnType<typeof dataLakeService.getDynamicDataLakeAccess>>;

const dedupe = (values: string[]): string[] => Array.from(new Set(values));

/**
 * Union the static registry into a scope's OPEN buckets, for admin/developer callers only.
 *
 * Three properties this function must keep, each pinned by a test:
 *  1. The added prefixes come from `registry`, NEVER from `scope`. The OPEN bucket is an
 *     ownership bypass in `buildOwnershipConditions`, whose contract is that its prefixes
 *     "MUST only ever be sourced from the hardcoded DATA_LAKES registry" - see
 *     packages/database/src/queries/fabFileSearchQuery.ts. Sourcing from `scope` would let a
 *     DB lake shadowing a registry id promote its user-controlled prefix into the bypass.
 *  2. `scopedTagPrefixes` passes through untouched - privilege never promotes a dynamic
 *     lake's prefix out of the owner/org-scoped arm.
 *  3. Dedupe is order-stable (scope first) so callers and tests see a deterministic list.
 *
 * `registry` is a parameter rather than a direct `DATA_LAKES` read because the registry is
 * env-dependent at module load (premium entries arrive via an env seam), which would
 * otherwise make this function's behavior - and its tests - environment-dependent.
 */
export function withStaticRegistryBypass(
  scope: RetrievalLakeScope,
  registry: DataLakeConfig[] = DATA_LAKES
): RetrievalLakeScope {
  return {
    // Carried through: widening a privileged caller's reach says nothing about whether the dynamic
    // read succeeded. Rebuilding this object without it would report an incomplete view to the one
    // thing that reads it - sessionService's retrieval-tag derivation, NOT narrowLakeAccessToSession
    // despite the similar name - and so skip that derivation's reachability intersection, for
    // admin/developer callers only.
    lakeViewComplete: scope.lakeViewComplete,
    dataLakeTags: dedupe([...scope.dataLakeTags, ...registry.map(lake => lake.datalakeTag)]),
    dataLakeTagPrefixes: dedupe([...scope.dataLakeTagPrefixes, ...registry.map(lake => lake.fileTagPrefix)]),
    scopedTagPrefixes: scope.scopedTagPrefixes,
    // Per-lake entries follow the same widening, or a privileged caller could search a registry
    // lake but not count it. Registry-sourced by construction, like the prefixes above, and
    // keyed on the globally-unique meta-tag so a lake the scope already resolved keeps its own
    // (possibly membership-carrying) entry.
    lakes: [
      ...scope.lakes,
      ...registry
        .filter(lake => !scope.lakes.some(resolved => resolved.datalakeTag === lake.datalakeTag))
        .map(lake => ({
          id: lake.id,
          name: lake.name,
          slug: lake.slug,
          datalakeTag: lake.datalakeTag,
          fileTagPrefix: lake.fileTagPrefix,
          source: 'registry' as const,
        })),
    ],
  };
}

/**
 * Resolve the caller's retrieval scope: their dynamic (DB) lakes plus the static registry
 * lakes they are entitled to, with prefixes already split by provenance (static -> OPEN,
 * dynamic -> SCOPED).
 *
 * Admin/developer callers additionally get the whole static registry in the OPEN bucket,
 * preserving the reach this endpoint has always given them. That widening lives HERE and not
 * in the core resolver on purpose: pushing it down would hand every admin's chat session
 * cross-tenant retrieval by default.
 *
 * It does NOT follow that chat can no longer see it. A session-creation path reaches this function
 * (sessionCrud -> deriveRetrievalTagsFromFiles), so a privileged caller's derivation runs against
 * the widened set and can persist a registry tag they hold no real lake for. That is bounded rather
 * than a leak: both consumers of `retrievalTags` use it to NARROW against an independently resolved
 * access scope, so the worst outcome is a privileged user's own session retrieving nothing. Keeping
 * the widening here still buys the thing that matters - it is not in the scope every chat turn
 * resolves for every caller.
 */
export async function resolveRetrievalLakeScope(req: RetrievalScopeRequest): Promise<RetrievalLakeScope> {
  const user = req.user!;
  // Thin memoizing wrapper over the request-free resolver below - the two MUST NOT drift, which is
  // why this holds no resolution logic of its own. All it adds is per-request memoization:
  // `getRequestEntitlements` and `getRequestMembershipOrgIds` each resolve once per request across
  // every consumer, rather than once per call.
  return resolveRetrievalLakeScopeForUser(user, {
    logger: req.logger,
    entitlementKeys: await getRequestEntitlements(req),
    // The resolver derives membership itself from user.id; serve that lookup from the request memo
    // so one request resolves membership once across toAccessContext and this scope. Any other id
    // (defense-in-depth - the resolver only asks about user.id today) falls through to the repo.
    findMembershipOrgIds: (uid: string) =>
      uid === user.id ? getRequestMembershipOrgIds(req) : organizationRepository.findMembershipOrgIds(uid),
  });
}

/**
 * The same retrieval scope, resolved WITHOUT a request.
 *
 * Exists because many session-creation call sites are not request-scoped - a manager taking
 * `{ user, ability, logger }`, a queue handler, an overlay service - and the request-shaped resolver
 * above cannot serve them.
 *
 * COVERAGE, stated precisely because an earlier version of this comment overstated it: of the four
 * call sites wired to this function, only `sessionCrud.getOrCreateSession` currently reaches the
 * derivation. The three route sites (voice-sessions, voice/v2/sessions, quest-plans continue) create
 * sessions with no `knowledgeIds`, and `sessionService.createSession` skips the derivation entirely
 * for an empty list - so their thunks cannot fire today. They are wired deliberately, so a route that
 * later attaches files is correct by default rather than silently unscoped; do not read them as four
 * live derivation paths. The mainline public-API path is covered separately by the request-shaped
 * wrapper above, via `POST /api/sessions/create`.
 *
 * Everything the request version added was MEMOIZATION, not authority: `getRequestEntitlements` is
 * `req.entitlements ??= getUserEntitlements(req.user)`, and nothing else in the tree writes that
 * memo, so it cannot hold a narrower set than `getUserEntitlements(user)` would return. Membership is
 * the same story by a different route: `getRequestMembershipOrgIds` takes no id and always resolves
 * `req.user.id`, and it is the WRAPPER's ternary above - not the memo - that sends any other id to the
 * repository. So this resolves the same values from the same sources; a caller with a request should
 * still prefer the wrapper above so one request pays once.
 */
export async function resolveRetrievalLakeScopeForUser(
  user: NonNullable<RetrievalScopeRequest['user']>,
  opts: {
    logger?: Logger;
    /** Pre-resolved keys (the request path passes its memo); resolved from the user when absent. */
    entitlementKeys?: string[];
    /** Pre-memoized membership lookup; falls back to the repository when absent. */
    findMembershipOrgIds?: (uid: string) => Promise<string[]>;
  } = {}
): Promise<RetrievalLakeScope> {
  // Resolved for every caller, including admins. The static-registry bypass below covers only STATIC
  // lakes, so an admin given no keys would lose an entitlement-gated DYNAMIC lake that a plain
  // subscriber holding the same key keeps.
  const entitlementKeys = opts.entitlementKeys ?? (await getUserEntitlements(user));

  // Projected field-for-field to what ToolContext hands the same function in the chat tool, so
  // "same lake set" is a property of the call, not a coincidence. Membership is resolved INSIDE the
  // shared resolver from user.id, not from user.organizationId (the selected-org display pointer).
  const scope = await dataLakeService.getDynamicDataLakeAccess({
    db: {
      dataLakes: dataLakeRepository,
      organizations: {
        findMembershipOrgIds: opts.findMembershipOrgIds ?? (uid => organizationRepository.findMembershipOrgIds(uid)),
      },
    },
    user: { id: user.id, tags: user.tags ?? [] },
    entitlementKeys,
    logger: opts.logger,
  });

  const isPrivileged = !!user.isAdmin || hasDeveloperUserTag(user.tags);
  return isPrivileged ? withStaticRegistryBypass(scope) : scope;
}
