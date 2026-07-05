import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake } from './authorizeLakeWrite';
import { recomputeLakeStats } from './recomputeLakeStats';

interface RemoveFileFromDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'setStats'>;
    fabFiles: Pick<IFabFileRepository, 'findById' | 'pullTagByFabFileId' | 'computeDataLakeStats'>;
  };
}

/**
 * Removes a single file from a data lake by dropping the lake's datalake: meta-tag from
 * the file - lake-scoped, NOT a global delete. The FabFile itself is untouched:
 * it stays in the owner's Files list, in any chats that reference it, and in any OTHER
 * lakes it still belongs to. Its chunks (content vectors keyed by fabFileId and shared
 * across every lake + general retrieval) are deliberately NOT deleted - they belong to
 * the file, which survives, so removing them would break retrieval everywhere else the
 * file is used. Chunk teardown belongs to file deletion, a separate action.
 *
 * Owner or admin only; the file must carry the lake's datalakeTag so callers can only
 * remove files that actually belong to the addressed lake (not-found-style denial
 * otherwise). Idempotent-safe: a second call 404s because the tag is already gone, so the
 * file no longer matches this lake - the correct "already removed" response for a retry.
 *
 * Note on the retrieval index: the RetrievalIndexPort only exposes removal by lake tag
 * (removeByDataLakeTag), which would de-index the ENTIRE lake - wrong for a single file.
 * OpenSearch-backed deployments reconcile the de-tagged file on the next whole-lake
 * operation. No per-file index call here.
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
  const inLake = !!file && (file.tags ?? []).some(t => t.name === lake.datalakeTag);
  if (!file || !inLake) {
    throw new NotFoundError('File not found in this data lake');
  }

  // Drop only this lake's meta-tag via an atomic $pull, leaving every other tag (and any
  // other lake membership) intact. $pull removes just the matching element, so a concurrent
  // removal of the same file from a DIFFERENT lake can't clobber this write the way a
  // read-filter-write of the whole tags array would (last-write-wins re-adding a tag).
  await db.fabFiles.pullTagByFabFileId(file.id, lake.datalakeTag);

  const stats = await recomputeLakeStats(dataLakeId, lake.datalakeTag, { db });
  return { success: true, ...stats };
};
