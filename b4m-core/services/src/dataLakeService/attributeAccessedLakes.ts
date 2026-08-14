import { datalakeTagsFrom } from './getDataLakePrompts';

/** The subset of a resolved lake's fields needed to reverse a file's tags back to a lake id. */
export interface AttributableLake {
  id: string;
  datalakeTag: string;
}

export interface AttributeAccessedLakeIdsOptions {
  /**
   * Whether an inconclusive attribution falls back to the full `lakes` scope. Default `true` -
   * sound ONLY when every possible result is guaranteed to be lake content (a search that was
   * itself restricted to lake-tagged/prefixed files, e.g. `semanticDataLakeSearch` or a
   * `restrictToDataLake` browse): there, a no-tag hit means "prefix-matched, not attributable",
   * never "not a lake file at all".
   *
   * Pass `false` for a MIXED corpus (owned + shared + org-shared + data lake, e.g. the keyword
   * fallback search or a browse without `restrictToDataLake`) - there, a no-tag hit commonly means
   * the result is the caller's own private file, and falling back to the full scope would record a
   * lake read that never happened.
   */
  allowFullScopeFallback?: boolean;
}

/**
 * Best-effort lake attribution for `LakeAccessEvent.resolvedLakeIds`: map each returned
 * file's tags back to the lake(s) whose `datalake:<slug>` meta-tag it carries. Only the
 * tag-matched arm is recoverable this way - a content-tag-PREFIX match never identified a single
 * lake and cannot be reversed here.
 *
 * Falls back to every lake in `lakes` (the full authorized/searched scope) when nothing in
 * `fileTagLists` carries a recoverable tag and `allowFullScopeFallback` is true - see the doc
 * comment on `resolvedLakeIds` in LakeAccessEventTypes.ts. A caller must never drop a lake from
 * its own audit trail just because attribution was inconclusive, so this is the ONE place that
 * decision is made, not each call site - but the caller still has to say whether the fallback is
 * SOUND for its corpus (see `allowFullScopeFallback`'s doc), since it isn't for every surface.
 */
export function attributeAccessedLakeIds(
  fileTagLists: Iterable<string[]>,
  lakes: AttributableLake[],
  options: AttributeAccessedLakeIdsOptions = {}
): string[] {
  const { allowFullScopeFallback = true } = options;
  const tagToId = new Map(lakes.map(lake => [lake.datalakeTag, lake.id]));
  const ids = new Set<string>();
  for (const tags of fileTagLists) {
    for (const tag of datalakeTagsFrom(tags)) {
      const id = tagToId.get(tag);
      if (id) ids.add(id);
    }
  }
  if (ids.size > 0) return [...ids];
  // The fallback is bounded by `lakes`, not a global "log everything" - a caller with no scope to
  // fall back to (e.g. an agent-scoped arm that passes []) correctly gets [] back, not a crash or
  // a fabricated lake id.
  return allowFullScopeFallback ? lakes.map(lake => lake.id) : [];
}
