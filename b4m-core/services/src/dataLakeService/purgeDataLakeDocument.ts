import type {
  DataLakeDocumentPurgeReceipt,
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IFabFileChunkRepository,
  IFabFileRepository,
  ISessionRepository,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLakeWritable } from './assertLakeAccess';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { isEffectiveOwner, type ManageActor } from './manageRule';
import { lakeMembershipSignals } from './lakeMembership';
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
    /** Chats keep the document in `knowledgeIds`; the purge unlinks it there like file deletion does. */
    sessions: Pick<ISessionRepository, 'findAllWithKnowledgeId' | 'update'>;
    /**
     * REQUIRED, unlike the optional grant repo on the lighter gates: this is the most destructive
     * door in the surface, and resolving the effective owner without grants silently answers with
     * the creator - who, after a transfer, is exactly the wrong person.
     */
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
  retrievalIndex?: RetrievalIndexPort;
  /**
   * Post-destruction hook for the effects that need app-side repositories this service does not
   * take: returning the owner's storage quota and rebuilding the stats of the OTHER lakes the
   * document belonged to. Mirrors `deleteFabFile`'s `onDeleteComplete`. Called once, after the
   * writes; a throw propagates, so keep it best-effort at the call site.
   */
  onPurged?: (purged: {
    /** The file's owner - NOT the actor, who may be an admin destroying someone else's document. */
    ownerUserId: string;
    /** Bytes to return to that owner's quota; 0 when the row carried no stored object. */
    fileSize: number;
    /** Every tag the file carried, pre-delete - the input to the other lakes' stats rebuild. */
    tagNames: string[];
  }) => Promise<void>;
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
 * `chunksRemaining` and `documentDeleted` are READ BACK after the writes, and they are what
 * `verified` is made of. `retrievalIndexPurged` is not: the port has no read operation, so it
 * reports that a wired index accepted the removal without a throw - `verified` makes no claim
 * about the index.
 *
 * A failure to fully converge does NOT throw. It returns `verified: false` with the counts that
 * say where it stopped, and logs at error level - a caller must be able to tell a partial sweep
 * from a clean one, and an exception carrying no counts tells them less than the receipt does.
 *
 * EFFECTIVE OWNER or admin only - deliberately one rung narrower than `canManageLake`, which the
 * reversible sibling uses: a curator or org admin may add and remove lake members, but destroying
 * a document everywhere is the owner's call. Grant-aware, so a transfer moves the right with
 * ownership rather than leaving it with the original creator. Hosts gate the button on the same
 * rule (`isOwn` on the lake DTO), so this throw is a backstop, not the first thing a user meets.
 *
 * Only a document the lake's read path actually admits (`lakeMembershipSignals`) can be reached -
 * an id that is not a member 404s rather than being destroyed.
 */
export const purgeDataLakeDocument = async (
  actor: ManageActor,
  dataLakeId: string,
  fabFileId: string,
  { db, retrievalIndex, onPurged, logger }: PurgeDataLakeDocumentAdapters
): Promise<DataLakeDocumentPurgeReceipt> => {
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }
  const grants = await loadActiveLakeGrants(lake, { db });
  if (!actor.isAdmin && !isEffectiveOwner(lake, actor, grants)) {
    throw new BadRequestError('Only the owner can permanently delete files from this data lake');
  }
  // A fallback lake has no document, so it has no members of its own to destroy.
  assertLakeWritable(lake);

  const file = await db.fabFiles.findById(fabFileId);
  const { inLake } = lakeMembershipSignals(lake, file);
  if (!file || !inLake) {
    throw new NotFoundError('File not found in this data lake');
  }

  const chunksBefore = await db.fabFileChunks.countByFabFileId(file.id);
  const embeddingModels = await db.fabFileChunks.distinctEmbeddingModelsByFabFileIds([file.id]);

  const scope = lakeMembershipScope(lake);
  await strictIndexRemove(retrievalIndex, { scope, fabFileIds: [file.id] });

  await db.fabFileChunks.deleteManyByFabFileId(file.id);
  await db.fabFiles.hardDeleteByIds([file.id]);

  // Same unlink `deleteFabFile` performs: a chat holding the id in `knowledgeIds` would otherwise
  // keep pointing at a row that no longer exists, and the confirmation copy promises otherwise.
  const linkedSessions = await db.sessions.findAllWithKnowledgeId(file.id);
  for (const session of linkedSessions) {
    await db.sessions.update({
      id: session.id,
      knowledgeIds: (session.knowledgeIds ?? []).filter(knowledgeId => knowledgeId !== file.id),
    });
  }

  // Read back rather than trusting the writes: this pair IS the verification. Truthiness, not
  // `=== null`: `BaseRepository.findById` returns `undefined` for a missing row behind a
  // `T | null` cast, so an equality check here can never see the row as gone.
  const chunksRemaining = await db.fabFileChunks.countByFabFileId(file.id);
  const documentDeleted = !(await db.fabFiles.findById(file.id));
  const verified = documentDeleted && chunksRemaining === 0;

  // The purged lake only. Every OTHER lake the document belonged to is the caller's to rebuild
  // through `onPurged` - resolving a tag back to its lake needs repositories this service does
  // not take.
  const { fileCount, totalSizeBytes } = await recomputeLakeStats(lake, { db });

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
    fileCount,
    totalSizeBytes,
  };

  if (verified) {
    logger?.info('[dataLake] permanently deleted a lake document', receipt);
  } else {
    logger?.error('[dataLake] permanent deletion did not fully converge', receipt);
  }

  await onPurged?.({
    ownerUserId: file.userId,
    fileSize: file.filePath && typeof file.fileSize === 'number' ? file.fileSize : 0,
    tagNames: (file.tags ?? []).map(tag => tag?.name).filter((name): name is string => !!name),
  });

  return receipt;
};
