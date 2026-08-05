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
import { dataLakeRepository } from '@bike4mind/database';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import { getRequestEntitlements, type EntitlementRequest } from '@server/entitlements';
import type { Logger } from '@bike4mind/observability';

/** EntitlementRequest carries no logger; the routes calling this are Express requests that do. */
type RetrievalScopeRequest = EntitlementRequest & { logger?: Logger };

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
    dataLakeTags: dedupe([...scope.dataLakeTags, ...registry.map(lake => lake.datalakeTag)]),
    dataLakeTagPrefixes: dedupe([...scope.dataLakeTagPrefixes, ...registry.map(lake => lake.fileTagPrefix)]),
    scopedTagPrefixes: scope.scopedTagPrefixes,
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
 * cross-tenant retrieval.
 */
export async function resolveRetrievalLakeScope(req: RetrievalScopeRequest): Promise<RetrievalLakeScope> {
  const user = req.user!;
  // Resolved for every caller, including admins. The bypass above covers only STATIC lakes,
  // so an admin given no keys would lose an entitlement-gated DYNAMIC lake that a plain
  // subscriber holding the same key keeps. Memoized on the request by getRequestEntitlements.
  const entitlementKeys = await getRequestEntitlements(req);

  // Projected field-for-field to what ToolContext hands the same function in the chat tool,
  // so "same lake set" is a property of the call, not a coincidence.
  const scope = await dataLakeService.getDynamicDataLakeAccess({
    db: { dataLakes: dataLakeRepository },
    user: {
      id: user.id,
      tags: user.tags ?? [],
      // Normalize once at the retrieval context seam, mirroring toAccessContext on the management
      // side (#1281): a populated-doc org id would otherwise reach the gate as "[object Object]".
      organizationId: normalizeId(user.organizationId),
    },
    entitlementKeys,
    logger: req.logger,
  });

  const isPrivileged = !!user.isAdmin || hasDeveloperUserTag(user.tags);
  return isPrivileged ? withStaticRegistryBypass(scope) : scope;
}
