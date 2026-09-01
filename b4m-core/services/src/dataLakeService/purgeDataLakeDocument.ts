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
      'countByFabFileId' | 'deleteManyByFabFileId' | 'distinctRetrievalIndexModelsByFabFileIds'
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
   * True when this deployment keeps vectors ON the chunk documents (Atlas), so the chunk delete
   * already removed them and no `retrievalIndex` is expected. It is what separates the two things
   * a missing port can mean - vectors collocated, or this door left unwired - in the receipt.
   */
  vectorsCollocated?: boolean;
  /**
   * The object store holding the file's bytes. REQUIRED: the caller returns the owner's quota on
   * the strength of this delete, and refunding bytes that are still stored drifts every quota it
   * touches. `filePath` lives only on the row this sweep destroys, so nothing downstream can find
   * the object afterwards - it is deleted here or it is orphaned forever.
   */
  storage: { delete: (path: string) => Promise<unknown> };
  /**
   * Called with the finished receipt BEFORE `onPurged`, so the durable record is filed while the
   * only thing left to do is best-effort bookkeeping. A throw propagates.
   */
  onReceipt?: (receipt: DataLakeDocumentPurgeReceipt) => Promise<void>;
  /**
   * Post-destruction hook for the effects that need app-side repositories this service does not
   * take: returning the owner's storage quota and rebuilding the stats of the OTHER lakes the
   * document belonged to. Mirrors `deleteFabFile`'s `onDeleteComplete`. Called once, after the
   * writes; a throw propagates, so keep it best-effort at the call site.
   */
  onPurged?: (purged: {
    /** The file's owner - NOT the actor, who may be an admin destroying someone else's document. */
    ownerUserId: string;
    /** Bytes to return to that owner's quota; 0 unless the stored object was actually deleted. */
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
 * `verified` is made of. `retrievalIndexOutcome` is not: the port has no read operation, so it
 * reports that a wired index accepted the removal without a throw, or which of the two reasons
 * there was no port - `verified` makes no claim about the index. `storageObjectDeleted` is the
 * object store's own answer, not a read-back either.
 *
 * A failure to fully converge does NOT throw. It returns `verified: false` with the counts that
 * say where it stopped, and logs at error level - a caller must be able to tell a partial sweep
 * from a clean one, and an exception carrying no counts tells them less than the receipt does.
 *
 * TWO ownership questions, both required. The lake's EFFECTIVE OWNER or a platform admin may open
 * this door - one rung narrower than `canManageLake`, which the reversible sibling uses, because a
 * curator or org admin manages membership while destroying a document is the owner's call, and
 * grant-aware so a transfer moves the right with ownership. AND the actor must own the FILE (or be
 * a platform admin), because the blast radius is global: see the gate below.
 *
 * Only a document the lake's read path actually admits (`lakeMembershipSignals`) can be reached -
 * an id that is not a member 404s rather than being destroyed.
 */
export const purgeDataLakeDocument = async (
  actor: ManageActor,
  dataLakeId: string,
  fabFileId: string,
  { db, retrievalIndex, vectorsCollocated, storage, onReceipt, onPurged, logger }: PurgeDataLakeDocumentAdapters
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

  // The lake is the authorization SCOPE, not a licence over other people's documents. The meta-tag
  // membership arm carries no ownership conjunct - a contributor's own upload is a lake member -
  // and this destruction is global, so without this a lake owner could erase a contributor's file
  // from that contributor's Files list and chats. `deleteFabFile` cannot do that (it resolves with
  // `findByIdAndUserId` and falls into unshare otherwise); neither may this door. A lake owner who
  // wants a stranger's file out of the lake has the reversible removal.
  if (!actor.isAdmin && file.userId !== actor.userId) {
    throw new BadRequestError('Only the file\'s owner can permanently delete this document');
  }

  const chunksBefore = await db.fabFileChunks.countByFabFileId(file.id);
  const embeddingModels = await db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds([file.id]);

  const scope = lakeMembershipScope(lake);
  await strictIndexRemove(retrievalIndex, { scope, fabFileIds: [file.id] });

  await db.fabFileChunks.deleteManyByFabFileId(file.id);
  await db.fabFiles.hardDeleteByIds([file.id]);

  // After the row, because `filePath` only lives on it: once it is gone nothing can find the
  // object again, so a failure here is an orphan nobody can name. Recorded rather than thrown, and
  // the quota refund below is withheld unless it succeeded - refunding retained bytes drifts the
  // owner's quota permissively with only an admin recalculate to undo it.
  let storageObjectDeleted = true;
  if (file.filePath) {
    try {
      await storage.delete(file.filePath);
    } catch (error) {
      storageObjectDeleted = false;
      // filePath is the only handle left: the row carrying it is already gone, so without it here
      // the orphaned object cannot be named, let alone cleaned up.
      logger?.error('[dataLake] permanent deletion could not remove the stored object', {
        fabFileId: file.id,
        filePath: file.filePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

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
    storageObjectDeleted,
    retrievalIndexOutcome: retrievalIndex ? 'purged' : vectorsCollocated ? 'collocated' : 'unwired',
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

  await onReceipt?.(receipt);

  await onPurged?.({
    ownerUserId: file.userId,
    fileSize:
      storageObjectDeleted && file.filePath && typeof file.fileSize === 'number' ? file.fileSize : 0,
    tagNames: (file.tags ?? []).map(tag => tag?.name).filter((name): name is string => typeof name === 'string'),
  });

  return receipt;
};
