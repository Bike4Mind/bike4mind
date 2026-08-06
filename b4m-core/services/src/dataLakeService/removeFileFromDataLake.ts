import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { removeFileFromLake } from './lakeMembership';
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
 * be removed rather than 404ing forever. The prefix arm additionally requires the file be owned
 * by the LAKE'S CREATOR, because fileTagPrefix is user-chosen and not org-scope unique: without
 * that conjunct, minting a lake with someone else's prefix would be a licence to strip their tags.
 *
 * The whole-lake predicate requires the same ownership conjunct on its prefix arm
 * (buildDataLakeMembershipFilter), so both this endpoint and the lake-wide sweep now ask the
 * identical question - "is this file the creator's" - matching the read path's own membership
 * predicate exactly. An admin may call this without owning the file themselves, but the file
 * itself must still belong to the lake's creator; an admin cannot use this to strip a prefixed
 * tag off a file the read path never actually admitted to this lake.
 *
 * A second lake sharing this prefix - not necessarily the caller's, since fileTagPrefix has no
 * org-scope uniqueness (same-creator collisions are blocked by a DB index; see tagPrefixCollision
 * for why org-scope is not) - loses the shared prefixed tag too. A lake holding its own meta-tag on
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
 * This entry point resolves the lake by id and recomputes stats; the membership write itself is
 * `removeFileFromLake` in lakeMembership.ts, shared with the tag-toggle door so both doors clear
 * the same signals.
 *
 * No retrieval-index call, though RetrievalIndexPort could now express a per-file removal: the
 * file is leaving the lake, not being deleted, so dropping its index entry would over-remove and
 * strip it from its OWNER's retrieval everywhere else. That is why the lifecycle doors call the
 * port and this one does not - they destroy or hide the file, this one only unpicks membership.
 * That membership removal is enforced by Mongo tag state, so it takes effect on the next
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

  await removeFileFromLake(actor, lake, fabFileId, { db });

  const stats = await recomputeLakeStats(lake, { db });
  return { success: true, ...stats };
};
