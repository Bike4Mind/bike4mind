import { openLakeTagPrefix, prefixArmTagNames, type DataLakeMembershipScope } from '@bike4mind/common';
import { datalakeTagsFrom } from './getDataLakePrompts';

/**
 * The subset of a resolved lake's fields needed to reverse a file's tags back to a lake id -
 * `fileTagPrefix` (with `id`) is what lets `openLakeTagPrefix` recover a static-registry lake
 * whose files carry only a content-tag prefix and no `datalake:<slug>` meta-tag at all.
 *
 * `membership` does the same job for a DYNAMIC lake, whose user-chosen prefix is only safe to
 * reverse when conjoined with the creator ownership it carries - see the third arm below.
 * `ResolvedLakeAccess` satisfies this structurally, so callers pass their resolved lakes as-is.
 */
export interface AttributableLake {
  id: string;
  datalakeTag: string;
  fileTagPrefix?: string;
  membership?: DataLakeMembershipScope;
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
 * fallback of any kind. All three arms live here so the tag->lake rule has exactly one home; the
 * inconclusive-attribution policy stays in the callers, which is what lets `supersession.ts` treat
 * "no recoverable tag" as "groups only with itself" while the audit trail treats it as "the whole
 * scope" (see `allowFullScopeFallback`).
 *
 * `ownerUserId` is the file's `userId`, and it enables the dynamic-lake prefix arm ONLY - every
 * other arm ignores it. A caller that cannot supply it (the audit trail below reverses bare tag
 * lists) keeps exactly the two arms it had, so widening this function changed no existing result.
 */
export function attributeFileToLakeIds(tags: string[], lakes: AttributableLake[], ownerUserId?: string): string[] {
  // `FabFile.tags` is a schema-less `[Object]` array (see FabFileModel), so a legacy row can hold an
  // entry with no `name` and every caller's `tags.map(t => t.name)` then yields `undefined`. Both
  // arms below string-inspect these names, so the guard lives here - the one place that does - and
  // an unnameable tag is simply not an attribution signal.
  const names = tags.filter((tag): tag is string => typeof tag === 'string');
  const ids = new Set<string>();
  // Map, not a per-tag `find`: two lakes can carry the same `datalakeTag` (slugs are not unique
  // across scopes), and the map's last-write-wins keeps the resolution this function has always had.
  const lakeIdByTag = new Map(lakes.map(l => [l.datalakeTag, l.id]));
  for (const tag of datalakeTagsFrom(names)) {
    const id = lakeIdByTag.get(tag);
    if (id) ids.add(id);
  }
  // A static-registry lake's files structurally cannot carry its meta-tag (no write path
  // stamps one for a fallback lake), so without this arm every retrieval of registry content
  // would fall through as "inconclusive" - not an edge case, the NORMAL shape of a read there.
  // `openLakeTagPrefix` returns undefined for a dynamic lake, so this arm never treats a
  // user-controlled prefix as a standalone signal; that case is the ownership-anchored arm below.
  for (const lake of lakes) {
    const prefix = openLakeTagPrefix(lake);
    if (prefix && names.some(t => t.startsWith(prefix))) ids.add(lake.id);
  }
  // DYNAMIC lake prefix arm, and the ONE reason a user-chosen prefix is reversible here: it is
  // conjoined with POSITIVE ownership, exactly as `buildDataLakeMembershipFilter` conjoins it in
  // `@bike4mind/database`. That predicate is the authority on who is a member of a lake; this is
  // its in-memory mirror for the read path, built from the same `DataLakeMembershipScope` and the
  // same `prefixArmTagNames` helper, so the two cannot drift on prefix normalization or on the
  // reserved-namespace refusal. Keep them in sync - a parity test pins the correspondence.
  //
  // Without the ownership conjunct this arm would be a cross-tenant hole: `fileTagPrefix` is
  // user-chosen and unique only per creator, so any user could mint a lake with prefix `acme:` and
  // have every `acme:*` file in the database attribute to it. With it, a file can only ever
  // attribute to a lake whose creator already owns that file.
  //
  // `kind === 'owned'` is checked rather than assumed, matching `lakeMembershipsFrom`'s own
  // discriminant guard: a registry scope's prefix arm carries NO ownership conjunct, so letting one
  // reach this branch would reopen precisely the hole the conjunct closes. Registry lakes are the
  // arm above. A creator-less `owned` row falls through to meta-tag-only, the same fail-closed
  // direction the filter builder takes.
  if (ownerUserId) {
    for (const lake of lakes) {
      const membership = lake.membership;
      if (membership?.kind !== 'owned') continue;
      if (!membership.creatorUserId || membership.creatorUserId !== ownerUserId) continue;
      if (prefixArmTagNames(names, membership.fileTagPrefix).length > 0) ids.add(lake.id);
    }
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
