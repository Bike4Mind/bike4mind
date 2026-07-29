import { z } from 'zod';
import { DATALAKE_TAG_PREFIX } from '@bike4mind/common';
import {
  IDataLakeRepository,
  IFabFileDocument,
  IFabFileRepository,
  IFileTagRepository,
  IUserDocument,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { addFileToLake, removeFileFromLake, type MembershipLake } from '../dataLakeService/lakeMembership';
import { recomputeLakeStats } from '../dataLakeService/recomputeLakeStats';

const fabFileToggleTagsSchema = z.object({
  ids: z.array(z.string()),
  tags: z.array(z.string()),
});

interface FabFileToggleTagsAdapters {
  db: {
    fabFiles: Pick<
      IFabFileRepository,
      'shareable' | 'findById' | 'pullTagsByFabFileId' | 'pushTagsByFabFileId' | 'computeDataLakeStats'
    >;
    fileTags: Pick<IFileTagRepository, 'incrementFileCountBy'>;
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'setStats'>;
    users: { findById: (id: string) => Promise<IUserDocument | null> };
  };
}

const storedTagNames = (file: Pick<IFabFileDocument, 'tags'>): string[] =>
  (file.tags ?? []).map(t => t?.name).filter((name): name is string => typeof name === 'string');

const isDataLakeTag = (tag: string): boolean => tag.toLowerCase().startsWith(DATALAKE_TAG_PREFIX);

/**
 * Flip each named tag on or off for each named file: a tag the file already carries is removed,
 * one it does not is added.
 *
 * A `datalake:*` meta-tag is NOT an ordinary tag - it is what makes a file a MEMBER of a lake, so
 * toggling one is a lake join or leave and is routed through the shared membership writes instead
 * of being written here. That is what keeps this door honest about leaving: dropping the meta-tag
 * alone left the file matching the lake's `fileTagPrefix` arm, so it kept appearing in the lake's
 * browse and retrieval. Lake stats are recomputed once per touched lake, not once per file.
 *
 * Both directions are element-level atomic writes. The whole `tags` array is never rewritten:
 * that let a slow writer's snapshot resurrect a tag a concurrent removal from a DIFFERENT lake
 * had just pulled. Stored casing survives in both directions - the name to remove is resolved
 * from the document, and a new name is written as the caller spelled it rather than lowercased.
 *
 * The accessibility check is all-or-nothing and runs before any write, but the writes themselves
 * are not transactional: if one file fails mid-batch, the files already written stay written.
 * Every write is idempotent, so retrying the same call converges rather than double-applying.
 */
export const toggleTags = async (userId: string, params: unknown, { db }: FabFileToggleTagsAdapters) => {
  const { ids, tags: requestedTags } = fabFileToggleTagsSchema.parse(params);

  // Toggling one tag twice in a request is meaningless, and acting on it twice is harmful: the
  // second pass reads the same pre-write snapshot, so it repeats the write and double-counts the
  // registry. Case-insensitively, because that is how a tag is matched below.
  const seen = new Set<string>();
  const tags = requestedTags.filter(tag => {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Get user for permission checks
  const user = await db.users.findById(userId);
  if (!user) throw new Error('User not found');

  // Only get files that the user has update access to
  const fabFiles = await db.fabFiles.shareable.findAllAccessibleByIds(user, ids);

  // Check if user has permission to update all requested files
  if (fabFiles.length !== ids.length) {
    throw new Error('Some files are not accessible or you do not have permission to edit them');
  }

  const actor = { userId, isAdmin: !!user.isAdmin };
  const tagCounters: Record<string, number> = {};
  const lakesByTag = new Map<string, Promise<MembershipLake>>();
  const touchedLakes = new Map<string, MembershipLake>();

  // One lookup per distinct meta-tag rather than one per (file, tag) pair. The PROMISE is cached,
  // not its result: files are processed concurrently, so caching only on resolve would let every
  // file in the batch issue its own lookup before the first one came back.
  const resolveLake = (tag: string): Promise<MembershipLake> => {
    // datalakeTag values are canonically lowercase, so a mixed-case meta-tag still resolves to
    // its real lake - the same normalization the route-level gate applies.
    const key = tag.toLowerCase();
    const cached = lakesByTag.get(key);
    if (cached) return cached;
    const pending = db.dataLakes.findByDatalakeTag(key).then(lake => {
      if (!lake) {
        // Same refusal the route-level gate gives, so a meta-tag naming no lake is rejected
        // identically whichever check sees it first.
        throw new BadRequestError('Only the creator can add files to this data lake');
      }
      return lake;
    });
    lakesByTag.set(key, pending);
    return pending;
  };

  const toggleLakeMembership = async (file: IFabFileDocument, tag: string): Promise<void> => {
    const lake = await resolveLake(tag);
    touchedLakes.set(lake.id, lake);
    // Direction is decided on an EXACT match of the lake's canonical meta-tag - the same test
    // removeFileFromLake applies, so the two cannot disagree about which way to go. Two
    // consequences, both deliberate: a file carrying only the lake's prefixed tag gains the
    // meta-tag rather than counting as a member, and a meta-tag stored in some other casing (no
    // read arm matches it, so it grants no membership) is left alone while the canonical tag is
    // stamped.
    const isMember = storedTagNames(file).includes(lake.datalakeTag);
    if (!isMember) {
      await addFileToLake(actor, lake, file.id, { db });
      return;
    }
    try {
      await removeFileFromLake(actor, lake, file.id, { db });
    } catch (error) {
      // A concurrent removal landing between the read above and this write leaves nothing to
      // remove, which is the state the caller asked for anyway.
      if (!(error instanceof NotFoundError)) throw error;
    }
  };

  const toggleOrdinaryTag = async (file: IFabFileDocument, tag: string): Promise<void> => {
    const key = tag.toLocaleLowerCase();
    // Every stored casing, not just the first: legacy data can hold both `Foo` and `foo`, and
    // removing one while leaving the other reports the tag as off while it still matches.
    const present = storedTagNames(file).filter(name => name.toLocaleLowerCase() === key);
    if (present.length > 0) {
      await db.fabFiles.pullTagsByFabFileId(file.id, present);
      // The pull's return cannot gate this: timestamps make it report a modification even when
      // nothing matched, so a concurrent removal of the same tag still decrements here. The
      // registry is a display counter, and recreating the tag re-counts it.
      tagCounters[tag] = (tagCounters[tag] ?? 0) - 1;
      return;
    }
    // The push's return IS truthful - a name already present fails its filter and counts 0 - so
    // gate on it rather than on the pre-write snapshot, which a concurrent add makes stale.
    const inserted = await db.fabFiles.pushTagsByFabFileId(file.id, [tag]);
    if (inserted > 0) tagCounters[tag] = (tagCounters[tag] ?? 0) + 1;
  };

  // Tags are applied one at a time within a file - they mutate the same document - while files
  // are processed concurrently. allSettled rather than all, so every write has finished before
  // the stats below are recomputed: a rejection must not let the recompute race a write that is
  // still in flight.
  const outcomes = await Promise.allSettled(
    fabFiles.map(async file => {
      for (const tag of tags) {
        if (isDataLakeTag(tag)) {
          await toggleLakeMembership(file, tag);
        } else {
          await toggleOrdinaryTag(file, tag);
        }
      }
    })
  );

  for (const lake of touchedLakes.values()) {
    await recomputeLakeStats(lake.id, lake.datalakeTag, { db });
  }

  // Lake meta-tags are deliberately absent from these counters: they are lake membership, not
  // entries in the user's own tag list, and no other lake door touches the tag registry.
  await Promise.all(
    Object.entries(tagCounters).map(async ([tag, delta]) => {
      if (delta !== 0) await db.fileTags.incrementFileCountBy({ name: tag, userId }, delta);
    })
  );

  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failure) throw failure.reason;

  // Re-read: the writes above are element-level, so the documents loaded earlier no longer
  // reflect what is stored.
  return db.fabFiles.shareable.findAllAccessibleByIds(user, ids);
};
