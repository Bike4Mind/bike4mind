import type { getDynamicDataLakeAccess } from './getDynamicDataLakeTags';
import { datalakeTagsFrom } from './getDataLakePrompts';

/** The resolved access set `getDynamicDataLakeAccess` returns, narrowed by the function below. */
export type ResolvedLakeAccessSet = Awaited<ReturnType<typeof getDynamicDataLakeAccess>>;

/**
 * Whether a session's `retrievalTags` name a LAKE at all - by identity (`datalake:x`) or by an
 * accessible lake's file-tag prefix (`acme:`). Both shapes identify a lake, so both are an opinion.
 *
 * Only the `datalake:`-prefixed entries name a lake by identity. `retrievalTags` is not universally
 * lake identity: a curated surface may scope a session by a content tag instead (a course tag, a
 * file-tag prefix), and those are consumed elsewhere as a plain tag filter on file tags. Matching
 * them against `lake.datalakeTag` retains nothing, which would silently take a session that
 * deliberately enabled the knowledge tool and leave its lake arms permanently empty. So a tag list
 * carrying no lake identity means "no lake opinion" - the same no-op as an absent list - NOT
 * "no lakes". Falling back to "no opinion" for the PREFIX shape left those sessions on the full
 * owner-wide union, the very bug `narrowLakeAccessToSession` exists to close.
 *
 * EXPORTED because the narrowing's no-op and its narrow-to-nothing are two different states that a
 * caller pairing this with `restrictToDataLake` must tell apart, and it cannot: both can leave the
 * lake arms looking a certain way, but only the second means "the session asked to be lake-scoped".
 * Pairing `restrictToDataLake` with a no-op narrow drops the owner/shared/group base arms for a
 * session that expressed no lake opinion, silently confining its grounding to lake content. Keep
 * this and the narrowing on the SAME predicate - a second copy is how those two states re-merge.
 *
 * Returns a plain boolean, deliberately NOT a `sessionRetrievalTags is string[]` type predicate: it
 * answers false for a non-empty list that names no lake, so the predicate form would narrow the
 * argument to `undefined` in the false branch - or to `never` where it is declared `string[]`, as at
 * the forced-retrieval call site. A later `if (!sessionNamesALake(...)) { tags.filter(...) }` would
 * then type-check against `never` and hide a real error.
 */
export function sessionNamesALake(access: ResolvedLakeAccessSet, sessionRetrievalTags: string[] | undefined): boolean {
  if (!sessionRetrievalTags?.length) return false;
  if (datalakeTagsFrom(sessionRetrievalTags).length > 0) return true;
  return access.lakes.some(lake => !!lake.fileTagPrefix && sessionRetrievalTags.includes(lake.fileTagPrefix));
}

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
 * Two DIFFERENT empty results, and collapsing them is a widening bug: a session that names a lake
 * the caller cannot reach must end up with NO lake access (they asked for something they may not
 * have), while a session whose tags name no lake at all has expressed no lake opinion and must be
 * left alone. `sessionNamesALake` above is the line between them, and it is the same predicate a
 * caller must consult before pairing this with `restrictToDataLake`.
 */
export function narrowLakeAccessToSession(
  access: ResolvedLakeAccessSet,
  sessionRetrievalTags: string[] | undefined
): ResolvedLakeAccessSet {
  if (!sessionNamesALake(access, sessionRetrievalTags)) return access;

  // Non-empty past the guard above, which returns false for an absent or empty list.
  const tags = sessionRetrievalTags ?? [];
  const lakeTags = datalakeTagsFrom(tags);
  const prefixMatched = access.lakes.filter(lake => lake.fileTagPrefix && tags.includes(lake.fileTagPrefix));

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
    // Carried through: narrowing changes WHICH lakes are in scope, never whether the underlying read
    // saw them all. No consumer downstream of THIS function reads it today (the only reader is the
    // session-creation tag derivation, which never receives a narrowed set) - it is carried so the
    // value keeps meaning the same thing wherever the set travels, not to satisfy a live caller.
    lakeViewComplete: access.lakeViewComplete,
    dataLakeTags: access.dataLakeTags.filter(tag => wanted.has(tag)),
    dataLakeTagPrefixes: access.dataLakeTagPrefixes.filter(prefix => retainedPrefixes.has(prefix)),
    scopedTagPrefixes: access.scopedTagPrefixes.filter(prefix => retainedPrefixes.has(prefix)),
    lakes: retainedLakes,
  };
}
