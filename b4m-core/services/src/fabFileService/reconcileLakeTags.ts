import { DATALAKE_TAG_PREFIX, DATALAKE_TAG_STRENGTH } from '@bike4mind/common';
import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { assertLakeWritable } from '../dataLakeService/assertLakeAccess';
import { canManageLake } from '../dataLakeService/authorizeLakeWrite';
import {
  addFileToLake,
  removeFileFromLake,
  type MembershipActor,
  type MembershipLake,
} from '../dataLakeService/lakeMembership';
import { recomputeLakeStats } from '../dataLakeService/recomputeLakeStats';

interface ReconcileLakeTagsAdapters {
  db: {
    fabFiles: Pick<
      IFabFileRepository,
      'findById' | 'pullTagsByFabFileId' | 'pushTagsByFabFileId' | 'computeDataLakeStats'
    >;
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'setStats'>;
  };
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
 * during `commit()` would have already granted or revoked membership via the array write.
 *
 * A meta-tag that resolves to no lake is refused when the caller is trying to APPLY it, matching
 * the route gate; the same string being dropped is let through as a plain tag removal, since an
 * orphaned meta-tag left by a deleted lake must not make the file uneditable.
 */
export const reconcileLakeTags = async (
  actor: MembershipActor,
  fabFileId: string,
  currentTagNames: string[],
  desiredTags: { name: string; strength: number }[],
  { db }: ReconcileLakeTagsAdapters
): Promise<LakeTagReconciliation> => {
  const ordinaryTags = desiredTags.filter(tag => !isMetaTag(tag.name));
  const desiredKeys = new Set(desiredTags.filter(tag => isMetaTag(tag.name)).map(tag => tag.name.toLowerCase()));
  const currentKeys = new Set(currentTagNames.filter(isMetaTag).map(name => name.toLowerCase()));

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

  return {
    tagsToPersist: [...ordinaryTags, ...metaTagsToPersist.map(name => ({ name, strength: DATALAKE_TAG_STRENGTH }))],
    commit: async () => {
      for (const lake of leaves) {
        await removeFileFromLake(actor, lake, fabFileId, { db });
      }
      for (const lake of joins) {
        await addFileToLake(actor, lake, fabFileId, { db });
      }
      for (const lake of [...leaves, ...joins]) {
        await recomputeLakeStats(lake.id, lake.datalakeTag, { db });
      }
    },
  };
};
