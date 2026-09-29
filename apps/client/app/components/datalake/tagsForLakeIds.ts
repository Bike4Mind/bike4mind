/** A lake, reduced to the id -> tag mapping the session scope is written in. */
export interface TaggableLake {
  id: string;
  datalakeTag: string;
}

/**
 * Lake ids (what the picker selects) to lake tags (what the session stores and the retrieval
 * `$in` clause matches). See useSetLakeScope for why the conversion happens at that boundary.
 *
 * Returns LIST order, not selection order, so the same set of lakes always writes the same array
 * and an unchanged scope does not look like a change to anything diffing it.
 *
 * An id with no lake in the list is DROPPED rather than passed through as a guessed tag: the list
 * is access-filtered, so an unmatched id names a lake this caller cannot reach, and retrieval
 * would discard the tag anyway (resolveLakeMemoryScope intersects against entitled tags). Note
 * the consequence - selecting only unreachable lakes yields an empty array, which the caller
 * reads as the all-lakes scope rather than an empty one.
 */
export function tagsForLakeIds(lakes: TaggableLake[] | undefined, lakeIds: string[]): string[] {
  const wanted = new Set(lakeIds);
  return (lakes ?? []).filter(lake => wanted.has(lake.id)).map(lake => lake.datalakeTag);
}

/**
 * The inverse: lake tags back to the ids the picker selects. Unmatched tags are dropped for the
 * same reason - the list is access-filtered, so a tag with no lake in it names one this caller
 * can no longer reach, and honouring it would leave the picker claiming a scope retrieval has
 * already filtered away (resolveLakeMemoryScope intersects against entitled tags).
 */
export function lakeIdsForTags(lakes: TaggableLake[] | undefined, lakeTags: string[]): string[] {
  const wanted = new Set(lakeTags);
  return (lakes ?? []).filter(lake => wanted.has(lake.datalakeTag)).map(lake => lake.id);
}
