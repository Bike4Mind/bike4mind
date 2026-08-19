import type {
  DataLakeDocumentPurgeReceipt,
  IDataLakeRepository,
  IFabFileChunkRepository,
  IFabFileRepository,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLakeWritable } from './assertLakeAccess';
import { canManageLake } from './authorizeLakeWrite';
import { resolveLakeMembership } from './lakeMembership';
import { lakeMembershipScope } from './lakeMembershipScope';
import { recomputeLakeStats } from './recomputeLakeStats';
import { strictIndexRemove, type RetrievalIndexPort } from './ports';

interface PurgeDataLakeDocumentAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'setStats' | 'activateIfDraft'>;
    fabFiles: Pick<IFabFileRepository, 'findById' | 'hardDeleteByIds' | 'computeDataLakeStats'>;
    fabFileChunks: Pick<
      IFabFileChunkRepository,
      'countByFabFileId' | 'deleteManyByFabFileId' | 'distinctEmbeddingModelsByFabFileIds'
    >;
  };
  retrievalIndex?: RetrievalIndexPort;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

/**
 * Permanently destroy ONE document of a data lake - the FabFile record, its chunks, and the
 * vectors those chunks carry - and return a receipt proving it happened.
 *
 * This is the deliberate opposite of `removeFileFromDataLake`, which unpicks lake membership and
 * leaves the document and its chunks intact. Read that one first: the choice between them is the
 * whole distinction between "this lake no longer includes your file" and "your file is gone".
 * Because it is gone, the destruction is GLOBAL, not lake-scoped: the document also leaves the
 * owner's Files list, any chat that references it, and any OTHER lake it belonged to. There is no
 * soft-delete step and nothing restores it. The lake it is purged from is the authorization
 * scope, not the blast radius.
 *
 * Order matters and mirrors the phase-2 lake purge (`cleanupDeletedDataLake`): the retrieval
 * index goes first and strictly, so a throw there costs no progress and leaves nothing stranded
 * pointing at a row that no longer exists. See `strictIndexRemove` in ports.ts.
 *
 * A failure to fully converge does NOT throw. It returns `verified: false` with the counts that
 * say where it stopped, and logs at error level - a caller must be able to tell a partial sweep
 * from a clean one, and an exception carrying no counts tells them less than the receipt does.
 *
 * Lake creator or admin only, and only for a document the lake's read path actually admits
 * (`resolveLakeMembership`) - an id that is not a member 404s rather than being destroyed.
 */
export const purgeDataLakeDocument = async (
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  fabFileId: string,
  { db, retrievalIndex, logger }: PurgeDataLakeDocumentAdapters
): Promise<DataLakeDocumentPurgeReceipt> => {
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }
  if (!canManageLake(lake, actor)) {
    throw new BadRequestError('Only the creator can permanently delete files from this data lake');
  }
  // A fallback lake has no document, so it has no members of its own to destroy.
  assertLakeWritable(lake);

  const file = await db.fabFiles.findById(fabFileId);
  const { inLake } = resolveLakeMembership(lake, file);
  if (!file || !inLake) {
    throw new NotFoundError('File not found in this data lake');
  }

  const chunksBefore = await db.fabFileChunks.countByFabFileId(file.id);
  const embeddingModels = await db.fabFileChunks.distinctEmbeddingModelsByFabFileIds([file.id]);

  const scope = lakeMembershipScope(lake);
  await strictIndexRemove(retrievalIndex, { scope, fabFileIds: [file.id] });

  await db.fabFileChunks.deleteManyByFabFileId(file.id);
  await db.fabFiles.hardDeleteByIds([file.id]);

  // Read back rather than trusting the writes: this pair IS the verification.
  const chunksRemaining = await db.fabFileChunks.countByFabFileId(file.id);
  const documentDeleted = (await db.fabFiles.findById(file.id)) === null;
  const verified = documentDeleted && chunksRemaining === 0;

  const stats = await recomputeLakeStats(lake, { db });

  const receipt: DataLakeDocumentPurgeReceipt = {
    dataLakeId: lake.id,
    datalakeTag: lake.datalakeTag,
    fabFileId: file.id,
    fileName: file.fileName,
    chunksBefore,
    chunksRemaining,
    embeddingModels,
    documentDeleted,
    retrievalIndexPurged: !!retrievalIndex,
    verified,
    purgedAt: new Date().toISOString(),
    ...stats,
  };

  if (verified) {
    logger?.info('[dataLake] permanently deleted a lake document', receipt);
  } else {
    logger?.error('[dataLake] permanent deletion did not fully converge', receipt);
  }

  return receipt;
};
