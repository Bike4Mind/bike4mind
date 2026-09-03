import type {
  DataLakeDocumentPurgeReceipt,
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IFabFileChunkRepository,
  IFabFileRepository,
  ILakeConfigChangeEventRepository,
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
    fabFiles: Pick<IFabFileRepository, 'findById' | 'hardDeleteOneById' | 'computeDataLakeStats'>;
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
    /**
     * Passed straight through to `recomputeLakeStats`, which spreads a caller's `lakeConfigAuditDb`
     * (see that constant) into the audit trail a draft-lake auto-activation writes. Optional here
     * for the same reason it is optional on `LakeConfigAuditAdapters`: a caller that omits it still
     * gets a correct recompute, just an unaudited activation.
     */
    lakeConfigChangeEvents?: Pick<ILakeConfigChangeEventRepository, 'record'>;
    adminSettings?: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
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
   * Crypto-shred the facts this document contributed to the memory ledger of EVERY lake it
   * belonged to by EITHER membership arm - not just the lake the purge was authorized through.
   * Extraction (`extractLakeMemory`) runs per lake, so a file belonging to two lakes produces
   * beliefs on both ledgers under the same `fabFileId`; scoping the shred to one lake would leave
   * the other lake folding and recalling beliefs sourced from a document it was told is gone.
   * Optional only because the service cannot reach the ledger repository itself; a host that
   * leaves it unwired keeps recalling those beliefs. Called once, after the destruction converged,
   * with every tag the file carried (see `tagNames` below) plus the purging lake's own identity
   * (`purgingLake`) - the host resolves the file's OTHER member lakes from the tags and shreds the
   * purging lake directly. Unlike `onPurged`'s other-lakes stats rebuild, the purging lake is NOT
   * excluded: that rebuild skips it because `recomputeLakeStats` already covered it directly, but
   * nothing here does the purging lake's shred for it. A host that catches and logs per-lake (as
   * the one wired host does) should say so on its own hook, since it changes the "a throw
   * propagates" contract this adapter would otherwise imply.
   */
  shredDocumentMemory?: (args: {
    /** Every tag the file carried before deletion, unfiltered - the host resolves membership. */
    tagNames: string[];
    /** The `sources` entry every extracted fact carries. */
    fabFileId: string;
    /** The file's owner - needed to resolve the owner-anchored prefix membership arm. */
    ownerUserId: string;
    /**
     * The lake this purge was authorized through, handed over directly rather than folded into
     * `tagNames` for the host to resolve back: a prefix-arm member (see `lakeMembershipSignals`)
     * carries no `datalake:*` tag for this lake at all, and resolving one back through a
     * meta-tag lookup risks a case-sensitivity mismatch a direct handoff cannot have.
     */
    purgingLake: { id: string; datalakeTag: string; createdByUserId: string };
  }) => Promise<void>;
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
 * pointing at a row that no longer exists. See `strictIndexRemove` in ports.ts. Because it runs
 * before the storage sweep below, a refusal there on self-host OpenSearch can leave chunks whose
 * external index entries are already gone - narrower than the pre-storage-check version of this
 * sweep, and it matches the same tradeoff `strictIndexRemove` already makes.
 *
 * `chunksRemaining` and `documentDeleted` are READ BACK after the writes; together with
 * `storageObjectDeleted` they are what `verified` is made of. `retrievalIndexOutcome` is not: the
 * port has no read operation, so it reports that a wired index accepted the removal without a
 * throw, or which of the two reasons there was no port - `verified` makes no claim about the index.
 * `storageObjectDeleted` is the object store's own answer over EVERY stored key (the current one
 * and every prior version's), not a read-back either.
 *
 * The one survivor `verified` does not cover: an embedding of a purged chunk can persist in the
 * global EmbeddingCache, which is keyed by content hash and model with no file id, so nothing here
 * can reach it. Shared with `cleanupDeletedDataLake`; the copy is worded to match.
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
  {
    db,
    retrievalIndex,
    vectorsCollocated,
    storage,
    shredDocumentMemory,
    onReceipt,
    onPurged,
    logger,
  }: PurgeDataLakeDocumentAdapters
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
    throw new BadRequestError("Only the file's owner can permanently delete this document");
  }

  const chunksBefore = await db.fabFileChunks.countByFabFileId(file.id);
  const embeddingModels = await db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds([file.id]);

  const scope = lakeMembershipScope(lake);
  await strictIndexRemove(retrievalIndex, { scope, fabFileIds: [file.id] });

  // EVERY stored key, not just the current one. An AI-edited file keeps its earlier revisions in
  // `versions[]`, each under its own object key (see appendEditedVersion), and `filePath` names only
  // the newest - so deleting that alone leaves the original document's bytes behind while the
  // receipt claims the file is gone.
  const storageKeys = Array.from(
    new Set(
      [file.filePath, ...(file.versions ?? []).map(version => version?.filePath)].filter(
        (path): path is string => typeof path === 'string' && path.length > 0
      )
    )
  );

  // BEFORE the chunks and the row: those two writes are the ones a retry cannot re-derive once
  // done (chunks feed the lake-health rollups, and the row is the only thing naming these keys).
  // If the object store refuses, nothing destructive has happened yet, so the document, its
  // chunks and its rollups stay consistent and a retry converges.
  const storageKeysUnreached: string[] = [];
  for (const path of storageKeys) {
    try {
      await storage.delete(path);
    } catch (error) {
      storageKeysUnreached.push(path);
      logger?.error('[dataLake] permanent deletion could not remove a stored object', {
        fabFileId: file.id,
        filePath: path,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  const storageObjectDeleted = storageKeysUnreached.length === 0;

  // Nothing destructive until the bytes are gone: a refusal costs zero progress, so the row, its
  // chunks and its rollups stay consistent and a retry converges.
  let deletedByThisCall = false;
  if (storageObjectDeleted) {
    await db.fabFileChunks.deleteManyByFabFileId(file.id);

    // Atomic, and it answers whether THIS call removed the row. Two concurrent purges both find the
    // gates open and both see the object-store delete succeed (deleting an absent key is a no-op),
    // so without this claim both would refund the owner's quota for the same bytes.
    deletedByThisCall = await db.fabFiles.hardDeleteOneById(file.id);

    // Same unlink `deleteFabFile` performs: a chat holding the id in `knowledgeIds` would otherwise
    // keep pointing at a row that no longer exists, and the confirmation copy promises otherwise.
    const linkedSessions = await db.sessions.findAllWithKnowledgeId(file.id);
    for (const session of linkedSessions) {
      await db.sessions.update({
        id: session.id,
        knowledgeIds: (session.knowledgeIds ?? []).filter(knowledgeId => knowledgeId !== file.id),
      });
    }
  }

  // Read back rather than trusting the writes: this pair IS the verification. Truthiness, not
  // `=== null`: `BaseRepository.findById` returns `undefined` for a missing row behind a
  // `T | null` cast, so an equality check here can never see the row as gone.
  const chunksRemaining = await db.fabFileChunks.countByFabFileId(file.id);
  const documentDeleted = !(await db.fabFiles.findById(file.id));
  const verified = documentDeleted && chunksRemaining === 0 && storageObjectDeleted;

  // The purged lake only. Every OTHER lake the document belonged to is the caller's to rebuild
  // through `onPurged` - resolving a tag back to its lake needs repositories this service does
  // not take. `actor` threaded so a draft-lake auto-activation this purge triggers is attributed
  // to whoever (or whatever key) authorized the destruction, not filed as `system`.
  const { fileCount, totalSizeBytes } = await recomputeLakeStats(lake, { db, logger }, { actor });

  // Captured once and shared by shredDocumentMemory and onPurged below: both need the tags the row
  // carried pre-delete to resolve the file's OTHER member lakes.
  const tagNames = (file.tags ?? []).map(tag => tag?.name).filter((name): name is string => typeof name === 'string');

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
    storageObjectsTotal: storageKeys.length,
    storageObjectsRemaining: storageKeysUnreached.length,
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

  // Only once the document is genuinely gone: shredding the beliefs of a document that survived a
  // failed sweep would destroy recall for content still in the lake.
  if (verified) {
    await shredDocumentMemory?.({
      tagNames,
      fabFileId: file.id,
      ownerUserId: file.userId,
      purgingLake: { id: lake.id, datalakeTag: lake.datalakeTag, createdByUserId: lake.createdByUserId },
    });
  }

  await onPurged?.({
    ownerUserId: file.userId,
    // Gated on this call having removed the row, not merely on the object delete succeeding:
    // deleting an already-absent key succeeds, so a concurrent second purge would otherwise refund
    // the same bytes twice and ratchet the owner's quota down with only an admin recalculate to undo it.
    fileSize: deletedByThisCall && typeof file.fileSize === 'number' ? file.fileSize : 0,
    tagNames,
  });

  return receipt;
};
