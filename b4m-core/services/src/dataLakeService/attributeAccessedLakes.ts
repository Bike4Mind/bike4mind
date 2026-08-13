import { datalakeTagsFrom } from './getDataLakePrompts';

/** The subset of a resolved lake's fields needed to reverse a file's tags back to a lake id. */
export interface AttributableLake {
  id: string;
  datalakeTag: string;
}

/**
 * Best-effort lake attribution for `LakeAccessEvent.resolvedLakeIds` (#1678): map each returned
 * file's tags back to the lake(s) whose `datalake:<slug>` meta-tag it carries. Only the
 * tag-matched arm is recoverable this way - a content-tag-PREFIX match never identified a single
 * lake and cannot be reversed here.
 *
 * Falls back to every lake in `lakes` (the full authorized/searched scope) when nothing in
 * `fileTagLists` carries a recoverable tag - see the doc comment on `resolvedLakeIds` in
 * LakeAccessEventTypes.ts. A caller must never drop a lake from its own audit trail just because
 * attribution was inconclusive, so this is the ONE place that decision is made, not each call site.
 */
export function attributeAccessedLakeIds(fileTagLists: Iterable<string[]>, lakes: AttributableLake[]): string[] {
  const tagToId = new Map(lakes.map(lake => [lake.datalakeTag, lake.id]));
  const ids = new Set<string>();
  for (const tags of fileTagLists) {
    for (const tag of datalakeTagsFrom(tags)) {
      const id = tagToId.get(tag);
      if (id) ids.add(id);
    }
  }
  return ids.size > 0 ? [...ids] : lakes.map(lake => lake.id);
}
