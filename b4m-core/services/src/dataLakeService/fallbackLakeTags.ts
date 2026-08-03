import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { DATALAKE_TAG_PREFIX, normalizeTagPrefix, satisfiesTagPrefix } from '@bike4mind/common';
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

const satisfiesPrefix = (tags: readonly FileTag[], prefix: string): boolean =>
  satisfiesTagPrefix(
    tags.map(tag => tag?.name),
    prefix
  );

/**
 * Why a lake gets no automatic content tag, or the prefix to stamp under.
 *
 * `overlapCheckFailed` rides along with a PERMITTED decision rather than refusing, because the
 * two callers want opposite directions and only they can choose. The write doors stamp anyway -
 * a diagnostic lookup must never be the thing that fails a file write, and stamping is the
 * pre-existing behavior. A bulk backfill refuses instead: it mints across every legacy row at
 * once, so an unverified overlap there could hand a whole lake's files to another lake's
 * teardown. See the migration that consumes this.
 */
export type LakeStampDecision =
  | { stamp: true; prefix: string; overlapCheckFailed?: boolean }
  | { stamp: false; reason: 'unusable-prefix' | 'reserved-namespace' | 'prefix-overlap'; detail?: string };

type StampGateLake = Pick<IDataLakeDocument, 'id' | 'name' | 'fileTagPrefix' | 'createdByUserId' | 'organizationId'>;

/**
 * The ONE gate on "may this lake have a content tag minted for it, and under what prefix".
 *
 * Shared by the write-door reconciler below and the one-shot backfill migration, so the tags a
 * backfill writes are exactly the tags the live doors would have written. Re-deriving these
 * conditions in the migration is the drift this exists to prevent.
 */
export const decideStampPrefix = async (
  lake: StampGateLake,
  { dataLakes, logger }: { dataLakes: Pick<IDataLakeRepository, 'find'>; logger?: LakeTagAdapters['logger'] }
): Promise<LakeStampDecision> => {
  // An unusable prefix is dropped by the read arms and by the removal path too, so a tag built
  // on it would be invisible to every query and swept by nothing.
  const prefix = normalizeTagPrefix(lake.fileTagPrefix);
  if (!prefix) return { stamp: false, reason: 'unusable-prefix' };

  if (reachesMetaNamespace(prefix)) {
    logger?.warn?.(
      `[dataLakes] not stamping a content tag for "${lake.name}": its prefix ${prefix} reaches the reserved ${DATALAKE_TAG_PREFIX} namespace`
    );
    return { stamp: false, reason: 'reserved-namespace' };
  }

  // A prefix tag on a creator-owned file is full membership of any lake sharing that prefix,
  // including that lake's permanent delete. Minting one automatically would put this file in
  // another lake's teardown, so decline and say so.
  try {
    const clashes = await findCollidingPrefixLakes({ dataLakes }, lake.fileTagPrefix, {
      createdByUserId: lake.createdByUserId,
      organizationId: lake.organizationId,
      excludeLakeId: lake.id,
    });
    if (clashes.length > 0) {
      const detail = clashes.map(l => `"${l.name}" (${l.fileTagPrefix})`).join(', ');
      logger?.warn?.(
        `[dataLakes] not stamping a content tag for "${lake.name}": its prefix ${prefix} overlaps ${detail}, so the tag would grant those lakes membership of this file`
      );
      return { stamp: false, reason: 'prefix-overlap', detail };
    }
  } catch (err) {
    logger?.warn?.(`[dataLakes] could not check tag-prefix overlap for "${lake.name}"`, err);
    return { stamp: true, prefix, overlapCheckFailed: true };
  }

  return { stamp: true, prefix };
};

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
 * this only fires for rows predating them. Both live in `decideStampPrefix`, shared with the
 * backfill migration so the two cannot decide differently about the same lake.
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

      // Fail-OPEN on a failed overlap lookup is this door's choice, not the gate's: a diagnostic
      // must never be the thing that fails a file write, and stamping is the pre-existing
      // behavior it falls back to. The backfill migration reads the same flag and refuses.
      const decision = await decideStampPrefix(lake, { dataLakes: db.dataLakes, logger });
      return decision.stamp ? { prefix: decision.prefix } : null;
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
