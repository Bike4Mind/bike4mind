import { DATALAKE_TAG_PREFIX, normalizeTagPrefix } from '@bike4mind/common';
import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake } from './authorizeLakeWrite';
import { recomputeLakeStats } from './recomputeLakeStats';

interface RemoveFileFromDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'setStats'>;
    fabFiles: Pick<IFabFileRepository, 'findById' | 'pullTagsByFabFileId' | 'computeDataLakeStats'>;
  };
}

/**
 * Removes a single file from a data lake by clearing EVERY membership signal the read path
 * honors: the lake's datalake: meta-tag and any tag carrying the lake's fileTagPrefix.
 * Lake-scoped, NOT a global delete. The FabFile itself is untouched: it stays in the owner's
 * Files list, in any chats that reference it, and in any OTHER lakes it still belongs to. Its
 * chunks (content vectors keyed by fabFileId and shared across every lake + general
 * retrieval) are deliberately NOT deleted - they belong to the file, which survives, so
 * removing them would break retrieval everywhere else the file is used. Chunk teardown
 * belongs to file deletion, a separate action.
 *
 * Both signals, because a file is admitted into a lake on an exact meta-tag match OR a
 * fileTagPrefix match, OR'd (buildDataLakeMembershipFilter). Clearing only the meta-tag left the
 * file matching the prefix arm, so it kept appearing in the lake's browse and in retrieval while
 * the stats reported it as removed.
 *
 * Membership is TESTED against both signals too, so a file carrying only a prefixed tag can
 * be removed rather than 404ing forever. The prefix arm additionally requires the ACTOR to own
 * the file, because fileTagPrefix is user-chosen and neither unique nor reserved: without that
 * conjunct, minting a lake with someone else's prefix would be a licence to strip their tags.
 *
 * The whole-lake predicate requires ownership on its prefix arm too, but anchored to the lake's
 * CREATOR rather than the actor (buildDataLakeMembershipFilter). Neither rides a read share: both
 * are destructive, and a file someone else owns is not the lake's to hide or purge. The asymmetry
 * is only in WHOSE ownership counts - this endpoint strips tags on behalf of its caller, so it asks
 * "may THIS actor edit this file", while archive and delete act on the lake and ask "is this file
 * the creator's". So an admin removing one file must own it, while the lake-wide sweep they trigger
 * takes the creator's files instead.
 *
 * A second lake sharing this prefix - not necessarily the caller's, since nothing makes
 * fileTagPrefix unique - loses the shared prefixed tag too. A lake holding its own meta-tag on
 * the file keeps it and only loses the folder grouping, but a lake whose membership was
 * prefix-only loses the file outright. One tag string cannot be cleared for one lake and kept
 * for another.
 *
 * That "only loses the folder grouping" now costs more than it reads. Every lake file carries a
 * tag under its lake's prefix (see `fallbackLakeTags`), so for a co-prefixed second lake the
 * stripped tag can be the file's ONLY one under that prefix - it stays a member by meta-tag but
 * drops out of tag-counts and the tag tree entirely. Closing that means re-stamping the survivor
 * after the pull, which is not done here because the trade-off above is deliberate.
 *
 * The population this can reach is now narrow: create-time collision checks reject a prefix that
 * overlaps another lake's within the same org or creator (see `tagPrefixCollision`), so two
 * co-prefixed lakes need either legacy rows predating that guard, or a cross-scope pair whose
 * files one actor can nonetheless write to. Narrow, not impossible - hence the note rather than
 * a removal of the caveat.
 *
 * Lake owner or admin only. Idempotent-safe: a second call 404s because both signals are
 * already gone - the correct "already removed" response for a retry.
 *
 * No per-file retrieval-index call: RetrievalIndexPort exposes only removeByDataLakeTag,
 * which would de-index the ENTIRE lake, and it has no implementer here (bestEffortIndexRemove
 * no-ops without one). Removal is enforced by Mongo tag state, so it takes effect on the next
 * read - immediately and completely for the single-lake browse, today the only reader that sets
 * restrictToDataLake. Every other lake reader (the aggregate lake browse, lake semantic search,
 * the chat KB tools) still matches the prefix within the VIEWER's access, so the file's OWNER
 * still finds their own file there. That is ownership, not lake membership, and this function cannot change
 * it.
 */
export const removeFileFromDataLake = async (
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  fabFileId: string,
  { db }: RemoveFileFromDataLakeAdapters
): Promise<{ success: true; fileCount: number; totalSizeBytes: number }> => {
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }
  if (!canManageLake(lake, actor)) {
    throw new BadRequestError('Only the creator can remove files from this data lake');
  }

  const file = await db.fabFiles.findById(fabFileId);
  const tagNames = (file?.tags ?? []).map(t => t.name).filter((name): name is string => typeof name === 'string');
  // Normalized through the same predicate the read arms use, so a lake whose prefix no query
  // matches (empty, or missing its trailing colon) also gets nothing cleared by prefix.
  const prefix = normalizeTagPrefix(lake.fileTagPrefix);
  // Positive ownership: both ids must be present AND equal, so a file with no owner does not
  // fall through as a match.
  const ownsFile = actor.isAdmin || (!!file?.userId && file.userId === actor.userId);
  const prefixedTags = prefix ? tagNames.filter(name => name.startsWith(prefix)) : [];
  const inLake = !!file && (tagNames.includes(lake.datalakeTag) || (ownsFile && prefixedTags.length > 0));
  if (!file || !inLake) {
    throw new NotFoundError('File not found in this data lake');
  }

  // One atomic $pull for both signals. Two writes would leave a window - and on a crash, a
  // permanent state - where the meta-tag is gone but a prefixed tag still matches this lake.
  // $pull removes only matching elements, so a concurrent removal of the same file from a
  // DIFFERENT lake can't clobber this write the way a read-filter-write of the whole tags
  // array would (last-write-wins re-adding a tag).
  await db.fabFiles.pullTagsByFabFileId(file.id, [
    lake.datalakeTag,
    // Never strip another lake's membership: a lake whose fileTagPrefix sits inside the
    // reserved datalake: namespace would otherwise evict the file from every lake at once.
    ...prefixedTags.filter(name => !name.startsWith(DATALAKE_TAG_PREFIX)),
  ]);

  const stats = await recomputeLakeStats(lake, { db });
  return { success: true, ...stats };
};
