import type { IDataLakeRepository } from '@bike4mind/common';
import { DATALAKE_TAG_PREFIX, normalizeTagPrefix } from '@bike4mind/common';
import { extractDataLakeMetaTags } from './authorizeLakeWrite';
import { findCollidingPrefixLakes } from './tagPrefixCollision';

/**
 * Suffix stamped under a lake's `fileTagPrefix` for a file no other tag under that prefix
 * covers. Lowercase literal: the tag tree renders it as a node label.
 */
export const UNCATEGORIZED_TAG_SUFFIX = 'uncategorized';

type FileTag = { name: string; strength: number };

type LakeTagAdapters = {
  db: { dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'find'> };
  /**
   * Optional: the two skip paths below are silent without it, and both are worth knowing about.
   * Called as `logger?.warn?.()` - a diagnostic must never be the thing that fails a file write.
   */
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
};

/**
 * Whether a prefix reaches into the `datalake:` membership namespace, compared case-INSENSITIVELY.
 *
 * `isReservedTagPrefix` folds no case, and neither does the create-time refinement built on it, so
 * `DataLake:x:` is a storable prefix today. Minting under it is the harmful direction: the stamp
 * would be lowercased into a meta-tag by every later gated write, resolve to no lake, and make
 * `assertCanWriteDataLakeTags` reject every subsequent edit to that file - while this reconciler
 * re-appended the stamp on each attempt. Refusing to mint is free; whether create should also
 * reject the mixed-case form is a separate validation question.
 */
const reachesMetaNamespace = (prefix: string): boolean => prefix.trim().toLowerCase().startsWith(DATALAKE_TAG_PREFIX);

export interface ReconcileFallbackOptions {
  /**
   * The tags the file carried BEFORE this write, so a lake that has just lost its meta-tag can
   * have its stamped fallback retracted. Omit at creation doors, which have no prior state.
   */
  previousTags?: readonly { name?: unknown }[];
}

export type DataLakeFallbackTagger = <T extends FileTag>(
  tags: readonly T[],
  options?: ReconcileFallbackOptions
) => Promise<(T | FileTag)[]>;

/**
 * Does any tag already place this file under `prefix`?
 *
 * Case-SENSITIVE on purpose, unlike the meta-tag match: the consumers that decide whether the
 * file shows up under the prefix - `buildOwnershipConditions` and the tag-count aggregates -
 * build their regexes with no `i` flag, so `Acme:legal` genuinely does not satisfy `acme:`
 * for them. Lowercasing here would skip the stamp on a file those queries still see as
 * uncategorized.
 *
 * A meta-tag never satisfies a prefix (the counters exclude `datalake:*` from the tree), and
 * neither does a bare `acme:` with no suffix: that splits to `['acme', '']` and renders as an
 * unlabeled row in the tag tree, so it is not a category a user can navigate to.
 */
const satisfiesPrefix = (tags: readonly FileTag[], prefix: string): boolean =>
  tags.some(
    tag =>
      typeof tag?.name === 'string' &&
      tag.name.startsWith(prefix) &&
      tag.name.length > prefix.length &&
      !tag.name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX)
  );

/**
 * Reconcile a file's tag list against the data lakes it belongs to, enforcing one invariant:
 *
 *   a file carrying a lake's `datalake:*` meta-tag also carries at least one tag under that
 *   lake's `fileTagPrefix`.
 *
 * Without it a file can sit in a lake while contributing nothing to `tag-counts` and appearing
 * nowhere in the Explorer's tag tree, which is what happens to every flat (non-folder) upload:
 * the wizard derives its content tags from folder structure, so a root-level file yields none.
 *
 * The stamped tag is server-owned, so this also RETRACTS it for a lake present only in
 * `previousTags`: a write that drops the meta-tag should not leave behind a tag the server put
 * there on the strength of that membership.
 *
 * That is the limit of it, and worth stating plainly post-#1130, where a prefix tag on a
 * creator-owned file is membership in its own right. Retraction removes only this reconciler's own
 * stamp, so a file carrying user-authored prefix tags stays a member of the lake after its
 * meta-tag departs. That is #1130's design, not an oversight here - `removeFileFromDataLake` is
 * what actually removes a file, and it clears both signals.
 *
 * Ownership of the stamp is inferred from its NAME, so a user who authors a tag called exactly
 * `<prefix>uncategorized` will have it retracted as though the server had minted it. Harmless in
 * practice - it is the same name the server would have written - but it is why this is a naming
 * convention rather than a real ownership mechanism.
 *
 * Memoized per instance: one lake resolution per distinct meta-tag, so reconciling a 300-file
 * batch into one lake is a single pass.
 *
 * It declines to mint in two cases, both of which leave the file merely uncategorized rather than
 * risking something worse: a prefix that reaches the `datalake:` membership namespace, and a
 * prefix that overlaps another lake in the same scope. The second one matters because a prefix tag
 * on a creator-owned file IS lake membership - it counts toward the other lake's stats, its
 * archive sweep, and its permanent delete - so auto-minting under a shared prefix would hand one
 * lake's file to another lake's teardown. Create-time collision checks reject new overlaps, so
 * this only fires for rows predating them.
 */
export const createDataLakeFallbackTagger = ({ db, logger }: LakeTagAdapters): DataLakeFallbackTagger => {
  const lakeCache = new Map<string, Promise<{ prefix: string } | null>>();

  // Caches the PENDING promise, set synchronously before the lookup yields, so concurrent files
  // in one Promise.all share a single read. A rejection is cached too, on purpose: every file in
  // the batch then fails the same way instead of some retrying and succeeding, which would leave
  // the batch half-stamped. Do not "fix" this into a per-call retry.
  const resolvePrefix = (metaTag: string): Promise<{ prefix: string } | null> => {
    const cached = lakeCache.get(metaTag);
    if (cached) return cached;
    const pending = db.dataLakes.findByDatalakeTag(metaTag).then(async lake => {
      // No lake: either a stale tag on an existing file, or a STATIC-registry lake, which has no
      // Mongo document. Both are already unreachable through a gated door - the write gate uses
      // this same lookup and rejects what it cannot resolve - so skipping is the whole story
      // here. Skip rather than throw: a rename must not 400 over a tag it never touched.
      if (!lake) return null;

      // An unusable prefix is dropped by the read arms and by the removal path too, so a tag built
      // on it would be invisible to every query and swept by nothing.
      const prefix = normalizeTagPrefix(lake.fileTagPrefix);
      if (!prefix) return null;

      if (reachesMetaNamespace(prefix)) {
        logger?.warn?.(
          `[dataLakes] not stamping a content tag for "${lake.name}": its prefix ${prefix} reaches the reserved ${DATALAKE_TAG_PREFIX} namespace`
        );
        return null;
      }

      // A prefix tag on a creator-owned file is full membership of any lake sharing that prefix,
      // including that lake's permanent delete. Minting one automatically would put this file in
      // another lake's teardown, so decline and say so. Best-effort: a failed overlap lookup must
      // not fail the write, and stamping is the pre-existing behavior it falls back to.
      try {
        const clashes = await findCollidingPrefixLakes({ dataLakes: db.dataLakes }, lake.fileTagPrefix, {
          createdByUserId: lake.createdByUserId,
          organizationId: lake.organizationId,
          excludeLakeId: lake.id,
        });
        if (clashes.length > 0) {
          logger?.warn?.(
            `[dataLakes] not stamping a content tag for "${lake.name}": its prefix ${prefix} overlaps ${clashes
              .map(l => `"${l.name}" (${l.fileTagPrefix})`)
              .join(', ')}, so the tag would grant those lakes membership of this file`
          );
          return null;
        }
      } catch (err) {
        logger?.warn?.(`[dataLakes] could not check tag-prefix overlap for "${lake.name}"`, err);
      }

      return { prefix };
    });
    lakeCache.set(metaTag, pending);
    return pending;
  };

  return async <T extends FileTag>(tags: readonly T[], options?: ReconcileFallbackOptions) => {
    const currentMetaTags = extractDataLakeMetaTags(tags.map(tag => tag?.name));
    const previousMetaTags = extractDataLakeMetaTags((options?.previousTags ?? []).map(tag => tag?.name));
    const departed = previousMetaTags.filter(tag => !currentMetaTags.includes(tag));
    if (currentMetaTags.length === 0 && departed.length === 0) return tags as (T | FileTag)[];

    // Deduped by prefix, not by lake: two lakes can still share a `fileTagPrefix`, so one tag can
    // cover the file for both. Create-time collision checks now reject an overlapping prefix
    // within an org or creator (see `tagPrefixCollision`), which leaves legacy rows and
    // cross-scope pairs - narrow enough to be defensive, not narrow enough to assume away.
    const currentPrefixes = new Set<string>();
    for (const metaTag of currentMetaTags) {
      const resolved = await resolvePrefix(metaTag);
      if (resolved) currentPrefixes.add(resolved.prefix);
    }

    const retractions = new Set<string>();
    for (const metaTag of departed) {
      const resolved = await resolvePrefix(metaTag);
      // Keep a fallback whose prefix a lake the file STILL belongs to also claims - dropping it
      // would strip the file's only category tag from a lake it never left.
      if (!resolved || currentPrefixes.has(resolved.prefix)) continue;
      retractions.add(`${resolved.prefix}${UNCATEGORIZED_TAG_SUFFIX}`);
    }

    // Retract BEFORE deciding what to add, so satisfaction is judged on the tags that survive.
    // Prefixes can nest (`a:` and `a:b:` are both valid), so a departing lake's
    // `a:b:uncategorized` counts as satisfying a remaining lake's `a:`. Testing satisfaction
    // first would skip the addition and then retract the very tag it relied on.
    const kept = retractions.size > 0 ? tags.filter(tag => !retractions.has(tag?.name)) : tags;

    // Sorted, because prefixes can nest and a longer one's stamp satisfies a shorter one:
    // with `a:` and `a:x:`, stamping the inner lake first would leave the outer lake covered
    // only by `a:x:uncategorized`. Iterating shortest-first gives every lake its own node and
    // makes the result independent of the order tags happened to arrive in.
    const additions: FileTag[] = [];
    for (const prefix of [...currentPrefixes].sort()) {
      if (satisfiesPrefix([...kept, ...additions], prefix)) continue;
      additions.push({ name: `${prefix}${UNCATEGORIZED_TAG_SUFFIX}`, strength: 1 });
    }

    if (additions.length === 0 && retractions.size === 0) return tags as (T | FileTag)[];
    return [...kept, ...additions];
  };
};

/**
 * One-shot form for the single-file doors; the batch door wants the memoized tagger instead.
 *
 * `logger` belongs to the adapters, not the per-call options - destructuring it into `options`
 * would silence both skip paths at four of the five doors.
 */
export const reconcileDataLakeFallbackTags = async <T extends FileTag>(
  tags: readonly T[],
  { db, logger, ...options }: LakeTagAdapters & ReconcileFallbackOptions
): Promise<(T | FileTag)[]> => createDataLakeFallbackTagger({ db, logger })(tags, options);
