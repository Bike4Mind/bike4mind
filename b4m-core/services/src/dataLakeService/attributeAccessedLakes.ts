import { openLakeTagPrefix } from '@bike4mind/common';
import { datalakeTagsFrom } from './getDataLakePrompts';

/**
 * The subset of a resolved lake's fields needed to reverse a file's tags back to a lake id -
 * `fileTagPrefix` (with `id`) is what lets `openLakeTagPrefix` recover a static-registry lake
 * whose files carry only a content-tag prefix and no `datalake:<slug>` meta-tag at all.
 */
export interface AttributableLake {
  id: string;
  datalakeTag: string;
  fileTagPrefix?: string;
}

export interface AttributeAccessedLakeIdsOptions {
  /**
   * Whether an inconclusive attribution falls back to the full `lakes` scope. Default `true` -
   * sound ONLY when every possible result is guaranteed to be lake content (a search genuinely
   * restricted to lake-tagged/prefixed files, e.g. a browse with `restrictToDataLake: true`, or a
   * single already-authorized file reached via a lake gate): there, a no-tag hit means
   * "prefix-matched, not attributable", never "not a lake file at all".
   *
   * Pass `false` for a MIXED corpus (owned + shared + org-shared + data lake together) - there, a
   * no-tag hit commonly means the result is the caller's own private file, and falling back to the
   * full scope would record a lake read that never happened. This includes `semanticDataLakeSearch`
   * itself: its `collectScopedFiles` calls `fabfiles.search` with `includeShared: true` and no
   * `restrictToDataLake`, so `buildOwnershipConditions` ORs the caller's own/shared files into the
   * ranked corpus alongside the lake arms - it is NOT lake-only, despite ranking by a lake-scoped
   * embedding query.
   */
  allowFullScopeFallback?: boolean;
}

/**
 * Per-file half of the attribution below: the lake ids ONE file's tags can be reversed to, with no
 * fallback of any kind. Both arms live here so the tag->lake rule has exactly one home; the
 * inconclusive-attribution policy stays in the callers, which is what lets `supersession.ts` treat
 * "no recoverable tag" as "groups only with itself" while the audit trail treats it as "the whole
 * scope" (see `allowFullScopeFallback`).
 */
export function attributeFileToLakeIds(tags: string[], lakes: AttributableLake[]): string[] {
  const ids = new Set<string>();
  for (const tag of datalakeTagsFrom(tags)) {
    const lake = lakes.find(l => l.datalakeTag === tag);
    if (lake) ids.add(lake.id);
  }
  // A static-registry lake's files structurally cannot carry its meta-tag (no write path
  // stamps one for a fallback lake), so without this arm every retrieval of registry content
  // would fall through as "inconclusive" - not an edge case, the NORMAL shape of a read there.
  // A dynamic lake's prefix is user-controlled and excluded by `openLakeTagPrefix` itself, so it is
  // never a standalone attribution signal.
  for (const lake of lakes) {
    const prefix = openLakeTagPrefix(lake);
    if (prefix && tags.some(t => t.startsWith(prefix))) ids.add(lake.id);
  }
  return [...ids];
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
  const ids = new Set<string>();
  for (const tags of fileTagLists) {
    for (const id of attributeFileToLakeIds(tags, lakes)) ids.add(id);
  }
  if (ids.size > 0) return [...ids];
  // The fallback is bounded by `lakes`, not a global "log everything" - a caller with no scope to
  // fall back to (e.g. an agent-scoped arm that passes []) correctly gets [] back, not a crash or
  // a fabricated lake id.
  return allowFullScopeFallback ? lakes.map(lake => lake.id) : [];
}
