import { DATALAKE_TAG_PREFIX, DATALAKE_TAG_STRENGTH } from '@bike4mind/common';
import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLakeWritable } from '../dataLakeService/assertLakeAccess';
import { canManageLake, extractDataLakeMetaTags } from '../dataLakeService/authorizeLakeWrite';
import { reconcileDataLakeFallbackTags } from '../dataLakeService/fallbackLakeTags';
import { removeFileFromLake, type MembershipActor, type MembershipLake } from '../dataLakeService/lakeMembership';
import { findPrefixArmJoins, findPrefixArmLeaves } from '../dataLakeService/prefixArmMembership';
import { recomputeLakeStats } from '../dataLakeService/recomputeLakeStats';

interface ReconcileLakeTagsAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findById' | 'pullTagsByFabFileId' | 'computeDataLakeStats'>;
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'setStats' | 'activateIfDraft' | 'find'>;
  };
  /** Forwarded to the fallback tagger's skip-path diagnostics; never fails the write on its own. */
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
  /**
   * The FILE's owner - the prefix-arm membership predicate is anchored here, NOT the acting
   * user (a shared-edit file's owner can differ from whoever is editing it). Omitted, it is
   * resolved via `db.fabFiles.findById`, so a caller that forgets to pass it does not silently
   * lose the check.
   */
  fileOwnerUserId?: string;
}

export interface LakeTagReconciliation {
  /**
   * The tag array to persist. Every meta-tag the file must still hold when the membership writes
   * run is kept here, so the whole-array write cannot drop membership out from under them.
   */
  tagsToPersist: { name: string; strength: number }[];
  /** Run AFTER the tag array is persisted. Applies the joins and leaves, then recomputes stats. */
  commit: () => Promise<void>;
}

const isMetaTag = (name: string): boolean => name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX);

/**
 * Reconcile the lake membership implied by a WHOLE-ARRAY tag replacement (the shape
 * `PUT /api/files/:id` sends) against what the file currently holds, so that door obeys the same
 * removal semantics as the dedicated one: dropping a lake's `datalake:` meta-tag from the array
 * has to clear the lake's prefixed content tags too, or the file keeps matching the lake's prefix
 * arm in browse and retrieval, and either direction has to leave the lake's stats correct.
 *
 * Two-phase because a whole-array `$set` and an element-level membership write cannot be issued
 * in either order safely on their own: the caller persists `tagsToPersist` first (membership
 * intact), then calls `commit()`, which pulls or pushes the membership tags atomically. Every
 * gate is evaluated up front, before the caller persists anything - a check that only fired
 * during `commit()` would have already granted or revoked membership via the array write. A JOIN
 * therefore needs no write in `commit()` at all: the array the caller persists already carries the
 * canonical meta-tag. Only a LEAVE does, because clearing the lake's prefixed content tags cannot
 * be expressed as an absence in that array.
 *
 * Both callers today (`PUT /api/files/:id` and session summarization) wrap the array write and
 * `commit()` in one `withTransaction`, and the membership write reaches Mongoose as a query, so
 * `transactionAsyncLocalStorage` joins it to that session without it being threaded through: a
 * failure part-way through `commit()` rolls the whole thing back. Keep that wrapper. Called
 * WITHOUT one - the shape the tag-toggle door uses - the phases are separate writes, and a
 * failure between them leaves membership half-changed until the next recompute heals the stats.
 *
 * A meta-tag that resolves to no lake is refused when the caller is trying to APPLY it, matching
 * the route gate; the same string being dropped is let through as a plain tag removal, since an
 * orphaned meta-tag left by a deleted lake must not make the file uneditable.
 *
 * `tagsToPersist` is also run through the fallback tagger (see `fallbackLakeTags`) before it is
 * returned, so a lake joined here without a real content tag still gets its `<prefix>uncategorized`
 * stamp, and a plain edit that happens to drop a file's last qualifying tag for a lake it remains a
 * member of gets it backfilled too. Retraction never actually fires through this path: a genuine
 * leave clears every tag under the departing lake's OWN prefix inside `removeFileFromLake` below,
 * which already includes any stamp this reconciler minted, so nothing is left for the tagger to
 * retract by the time `commit()` runs.
 */
export const reconcileLakeTags = async (
  actor: MembershipActor,
  fabFileId: string,
  currentTagNames: string[],
  desiredTags: { name: string; strength: number }[],
  { db, logger, fileOwnerUserId }: ReconcileLakeTagsAdapters
): Promise<LakeTagReconciliation> => {
  const ordinaryTags = desiredTags.filter(tag => !isMetaTag(tag.name));
  const desiredKeys = new Set(extractDataLakeMetaTags(desiredTags.map(tag => tag.name)));
  const currentKeys = new Set(extractDataLakeMetaTags(currentTagNames));

  const joins: MembershipLake[] = [];
  const leaves: MembershipLake[] = [];
  const metaTagsToPersist: string[] = [];

  for (const key of new Set([...desiredKeys, ...currentKeys])) {
    const wanted = desiredKeys.has(key);
    const lake = await db.dataLakes.findByDatalakeTag(key);

    if (!lake) {
      if (wanted) {
        throw new BadRequestError('Only the creator can add files to this data lake');
      }
      continue;
    }

    // Membership is the CANONICAL tag, matched exactly, because that is what the read arm
    // matches. A meta-tag stored in any other casing confers nothing and is normalized away.
    const isMember = currentTagNames.includes(lake.datalakeTag);

    if (wanted) {
      metaTagsToPersist.push(lake.datalakeTag);
      if (!isMember) joins.push(lake);
    } else if (isMember) {
      // Persisted deliberately even though the caller dropped it: removeFileFromLake tests
      // membership against the stored document, and it clears the lake's prefixed content tags
      // only for a file it can still see in the lake.
      metaTagsToPersist.push(lake.datalakeTag);
      leaves.push(lake);
    }
  }

  for (const lake of joins) {
    if (!canManageLake(lake, actor)) {
      throw new BadRequestError('Only the creator can add files to this data lake');
    }
    assertLakeWritable(lake);
  }
  for (const lake of leaves) {
    if (!canManageLake(lake, actor)) {
      throw new BadRequestError('Only the creator can remove files from this data lake');
    }
    assertLakeWritable(lake);
  }

  const tagsToPersist = [
    ...ordinaryTags,
    ...metaTagsToPersist.map(name => ({ name, strength: DATALAKE_TAG_STRENGTH })),
  ];
  // previousTags only needs names: the tagger reads nothing else off it, and the departed-lake
  // set it computes is what the doc comment above notes never actually finds anything to retract.
  const reconciledTags = await reconcileDataLakeFallbackTags(tagsToPersist, {
    db,
    logger,
    previousTags: currentTagNames.map(name => ({ name })),
  });

  // A lake a file belongs to ONLY via its prefix arm (no meta-tag) never appears in the loop
  // above, which is keyed by meta-tag - so a write that drops that file's last tag under the
  // lake's prefix would otherwise skip both the manage-rights gate and the stats recompute.
  // Evaluated against `reconciledTags` (post-tagger), not the raw array: the fallback tagger can
  // mint a nested stamp that re-satisfies a departing lake's prefix, and judging the leave
  // against the pre-tagger array could evict a file the persisted array actually keeps as a
  // member. Nothing has been persisted yet, so "every gate evaluated up front" still holds.
  const cachedFile = fileOwnerUserId === undefined ? await db.fabFiles.findById(fabFileId) : undefined;
  const owner = fileOwnerUserId ?? cachedFile?.userId;
  const resultingTagNames = reconciledTags.map(t => t.name);
  const prefixArmLeaves = await findPrefixArmLeaves(
    { fileOwnerUserId: owner, currentTagNames, resultingTagNames },
    { db }
  );
  for (const { lake } of prefixArmLeaves) {
    if (!canManageLake(lake, actor)) {
      throw new BadRequestError('Only the creator can remove files from this data lake');
    }
    assertLakeWritable(lake);
  }
  leaves.push(...prefixArmLeaves.map(l => l.lake));

  // Force-carried, mirroring metaTagsToPersist above: removeFileFromLake checks membership
  // against the STORED document, so if the persisted array already dropped every prefix tag it
  // would see no member and treat the leave as a no-op race instead of actually revoking it.
  // Restores each tag's ORIGINAL strength (a content tag's strength is user-meaningful, unlike a
  // meta-tag's fixed DATALAKE_TAG_STRENGTH), so re-fetch the stored doc only on this rare path.
  let departingPrefixTags: { name: string; strength: number }[] = [];
  if (prefixArmLeaves.length > 0) {
    const storedFile = cachedFile ?? (await db.fabFiles.findById(fabFileId));
    const strengthByName = new Map((storedFile?.tags ?? []).map(t => [t.name, t.strength] as const));
    departingPrefixTags = prefixArmLeaves
      .flatMap(l => l.signalTags)
      .map(name => ({ name, strength: strengthByName.get(name) ?? DATALAKE_TAG_STRENGTH }));
  }

  // The mirror case: a write that newly satisfies a lake's prefix arm is automatic membership
  // (today's accepted model for content tags - no manage-rights gate), but it still needs its
  // stats recomputed, or fileCount stays stale until an unrelated recompute happens to run.
  const prefixArmJoins = await findPrefixArmJoins(
    { fileOwnerUserId: owner, currentTagNames, resultingTagNames },
    { db }
  );
  joins.push(...prefixArmJoins.map(j => j.lake));

  return {
    tagsToPersist: departingPrefixTags.length > 0 ? [...reconciledTags, ...departingPrefixTags] : reconciledTags,
    commit: async () => {
      for (const lake of leaves) {
        try {
          await removeFileFromLake(actor, lake, fabFileId, { db });
        } catch (error) {
          // A concurrent removal landing between the array write and this one leaves nothing to
          // remove, which is the state the caller asked for. Mirrors the tag-toggle door, so both
          // whole-array callers treat "already gone" the same way. Note that leaving two lakes
          // with the SAME fileTagPrefix in one call does NOT reach here: the first pull excludes
          // the reserved datalake: namespace, so the second lake's meta-tag survives it.
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      // Joins need no write here: the caller has already persisted the canonical meta-tag (or,
      // for a prefix-arm join, the qualifying content tag) as part of `tagsToPersist`, and their
      // gate (where one applies) ran above, before that write. They still need stats.
      for (const lake of [...leaves, ...joins]) {
        await recomputeLakeStats(lake, { db });
      }
    },
  };
};
