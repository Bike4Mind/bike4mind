import type { ICaller, IPromptBatchQuery, IPromptCatalog, IBriefcasePromptDocument } from '@bike4mind/common';
import type { BriefcaseServiceAdapters } from './ports';
import { assertCanReadPrompts, filterByEntitlement } from './briefcaseAccess';
import { getPersonalPrompts } from './getPersonalPrompts';

/**
 * Resolve a single catalog sub-query. Selector precedence: personal > tags > type.
 * A query with no selector resolves to an empty list (not an error).
 */
async function resolveQuery(
  query: IPromptBatchQuery,
  caller: ICaller,
  adapters: BriefcaseServiceAdapters
): Promise<IBriefcasePromptDocument[]> {
  if (query.personal) {
    return getPersonalPrompts(caller, adapters);
  }
  // Visibility is pushed INTO the query so the per-sub-query cap applies to the
  // already-entitled set. `null` => admin bypass (see all); otherwise the caller's
  // entitlements. filterByEntitlement stays as a case-insensitive, authoritative
  // post-filter (defense-in-depth against query/scope drift).
  const visibility = caller.isAdmin && !caller.isApiKey ? null : caller.entitlements;
  if (query.tags && query.tags.length > 0) {
    const prompts = await adapters.db.briefcasePrompts.listSystemByTags(query.tags, visibility);
    return filterByEntitlement(prompts, caller);
  }
  if (query.type) {
    const prompts = await adapters.db.briefcasePrompts.listSystemByType(query.type, visibility);
    return filterByEntitlement(prompts, caller);
  }
  return [];
}

/**
 * Batched catalog fetch. All-or-nothing by contract: any sub-query that throws
 * rejects the whole call (Promise.all), so the result is never a partial map.
 * The read gate runs first; personal sub-queries are caller-scoped.
 */
export async function getCatalog(
  queries: IPromptBatchQuery[],
  caller: ICaller | undefined,
  adapters: BriefcaseServiceAdapters
): Promise<IPromptCatalog> {
  assertCanReadPrompts(caller);
  const entries = await Promise.all(
    queries.map(async query => [query.key, await resolveQuery(query, caller, adapters)] as const)
  );
  return Object.fromEntries(entries);
}
