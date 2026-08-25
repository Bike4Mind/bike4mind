import type { getDynamicDataLakeAccess } from './getDynamicDataLakeTags';
import { datalakeTagsFrom } from './getDataLakePrompts';

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

  // Only the `datalake:`-prefixed entries name a LAKE. `retrievalTags` is not universally lake
  // identity: a curated surface may scope a session by a content tag instead (a course tag, a
  // file-tag prefix), and those are consumed elsewhere as a plain tag filter on file tags. Matching
  // them against `lake.datalakeTag` retains nothing, which would silently take a session that
  // deliberately enabled the knowledge tool and leave its lake arms permanently empty.
  //
  // So a tag list carrying no lake identity means "no lake opinion" - the same no-op as an absent
  // list - NOT "no lakes".
  const lakeTags = datalakeTagsFrom(sessionRetrievalTags);

  // A session may name its lake by IDENTITY (`datalake:x`) or scope itself by that lake's FILE-TAG
  // PREFIX (`acme:`), which is the shape a curated surface uses when it scopes by content. Both
  // identify a lake, so both narrow. Falling back to "no opinion" for the prefix shape left those
  // sessions on the full owner-wide union - the very bug this function exists to close, still open
  // on any account that can reach a second lake.
  // Two DIFFERENT empty results, and collapsing them is a widening bug: a session that names a lake
  // the caller cannot reach must end up with NO lake access (they asked for something they may not
  // have), while a session whose tags name no lake at all has expressed no lake opinion and must be
  // left alone. Only the second returns `access`.
  const prefixMatched = access.lakes.filter(
    lake => lake.fileTagPrefix && sessionRetrievalTags.includes(lake.fileTagPrefix)
  );
  if (lakeTags.length === 0 && prefixMatched.length === 0) return access;

  // UNION, not either/or: a session may name one lake by identity and another by prefix, and
  // dropping the prefix-named one would narrow it further than it asked for.
  const wantedTags = new Set(lakeTags);
  const byIdentity = access.lakes.filter(lake => wantedTags.has(lake.datalakeTag));
  const retainedLakes = [...byIdentity, ...prefixMatched.filter(lake => !byIdentity.includes(lake))];

  const wanted = new Set(retainedLakes.map(lake => lake.datalakeTag));
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
