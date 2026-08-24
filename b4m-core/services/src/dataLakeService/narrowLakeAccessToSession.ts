import type { getDynamicDataLakeAccess } from './getDynamicDataLakeTags';

/** The resolved access set `getDynamicDataLakeAccess` returns, narrowed by the function below. */
export type ResolvedLakeAccessSet = Awaited<ReturnType<typeof getDynamicDataLakeAccess>>;

/**
 * Narrow a caller's resolved lake access to the lakes their SESSION is scoped to
 * (`session.retrievalTags`, set by resolveLakeSessionDefaults or derived from a session's starting
 * files in sessionService.createSession).
 *
 * Purely subtractive: it can only remove lakes the caller already had access to, so it opens no new
 * access path. Without it, a session created FOR one lake still searches every lake its owner can
 * reach, because the knowledge tool resolves owner-wide access and never consults the session.
 *
 * FILTERS EACH BUCKET IN PLACE - never rebuilds them from `lakes`. `dataLakeTagPrefixes` is the OPEN
 * bucket, an ownership BYPASS in buildOwnershipConditions whose contract is that its prefixes are
 * sourced only from the hardcoded DATA_LAKES registry (see packages/database's fabFileSearchQuery).
 * Reconstructing the buckets from the lake list could promote a dynamic lake's user-controlled
 * prefix into that bypass; filtering can only ever remove, so bucket membership cannot move.
 *
 * A session tag naming a lake the caller cannot reach simply matches nothing, which is the correct
 * outcome (no lake content) rather than an error - callers already handle an empty tag set. An empty
 * or absent `sessionRetrievalTags` is a no-op: an unscoped session keeps its full access.
 */
export function narrowLakeAccessToSession(
  access: ResolvedLakeAccessSet,
  sessionRetrievalTags: string[] | undefined
): ResolvedLakeAccessSet {
  if (!sessionRetrievalTags?.length) return access;

  const wanted = new Set(sessionRetrievalTags);
  const retainedLakes = access.lakes.filter(lake => wanted.has(lake.datalakeTag));
  // Prefixes are matched by VALUE against the retained lakes, so a lake dropped from scope also
  // loses its prefix arm. Two lakes sharing a prefix is a pre-existing collision concern
  // (tagPrefixCollision.ts), not one this narrowing introduces.
  const retainedPrefixes = new Set(retainedLakes.map(lake => lake.fileTagPrefix));

  return {
    dataLakeTags: access.dataLakeTags.filter(tag => wanted.has(tag)),
    dataLakeTagPrefixes: access.dataLakeTagPrefixes.filter(prefix => retainedPrefixes.has(prefix)),
    scopedTagPrefixes: access.scopedTagPrefixes.filter(prefix => retainedPrefixes.has(prefix)),
    lakes: retainedLakes,
  };
}
