import type { Logger } from '@bike4mind/observability';
import {
  User,
  adminSettingsRepository,
  changeStorageSize,
  dataLakeBatchRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  scopedSettingsRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { isDataLakeTagName, matchesTagPrefixArm, type IFabFile, type IFabFileDocument } from '@bike4mind/common';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { createFabFile } from '@server/managers/fabFileManager';
import { evaluateConnectorCopyDeletion } from '@server/integrations/google/drive/connectorCopyGate';
import { getFilesStorage } from '@server/utils/storage';
import { lakeMembershipAuditDb } from '@server/dataLakes/lakeMembershipAuditDb';
import { finalizeBatchIfComplete } from '@server/queueHandlers/dataLakeBatchProgress';

// Shared by the connector ingests: driveLakeIngest.ts and githubLakeIngest.ts (via githubLakeSlice.ts).

export type IngestLake = NonNullable<Awaited<ReturnType<typeof dataLakeRepository.findById>>>;
export type ConnectorMembershipActor = { userId: string; isAdmin: boolean };
export type RetireOutcome = 'unpicked' | Awaited<ReturnType<typeof fabFilesService.deleteFabFile>>['action'];

export type LakeIngestRetirerContext = {
  lake: IngestLake;
  membershipActor: ConnectorMembershipActor;
  /** Who every replacement copy is minted for (the connection's connectedBy). */
  replacementOwnerId: string;
  /** Owners a prefix arm could reach: the replacement owner plus every stored copy's owner. */
  candidateOwnerIds: string[];
  logTag: string;
  logger: Logger;
};

export function createLakeIngestRetirer(ctx: LakeIngestRetirerContext) {
  const { lake, membershipActor, replacementOwnerId, logTag, logger } = ctx;

  // Bytes reclaimed by the full deletes below, accumulated PER OWNER: after a reconnect the copies
  // one run retires can belong to more than one user (see retireSupersededCopy), and each one's
  // quota has to be given back to the right document.
  const reclaimedBytesByUserId = new Map<string, number>();

  // Every lake whose PREFIX arm could reach a file owned by anyone in this connection's stored set,
  // or by whoever is connected now. Memoized: resolved ONCE for the whole run rather than per retire,
  // and not at all on a run that retires nothing - the common poll outcome. Membership is still
  // re-asserted per lake, per owner, inside findOtherLakeClaims.
  let candidateLakesOnce: ReturnType<typeof dataLakeService.loadPrefixArmCandidateLakes> | undefined;
  const prefixArmCandidateLakes = () =>
    (candidateLakesOnce ??= dataLakeService.loadPrefixArmCandidateLakes(ctx.candidateOwnerIds, {
      db: { dataLakes: dataLakeRepository },
    }));

  // deleteFabFile throws when its actor no longer exists, which would fail the whole reconcile on a
  // deterministic condition (an owner deleted since ingest) - retried to the DLQ, never converging.
  // Resolve once per owner and skip that copy instead.
  const ownerExists = new Map<string, boolean>();
  const ownerStillExists = async (ownerId: string) => {
    const cached = ownerExists.get(ownerId);
    if (cached !== undefined) return cached;
    const exists = !!(await userRepository.findById(ownerId));
    ownerExists.set(ownerId, exists);
    return exists;
  };

  /**
   * Move what the hard delete is about to destroy onto the fresh copy superseding it: the notebook
   * attachments (deleteFabFile strips the retired id from every session's `knowledgeIds`) and the
   * tags a human applied by hand (the replacement is minted with this lake's tags only).
   *
   * Only ever called on the delete branch. On the unpicked branch the retired copy keeps living
   * with its links and tags intact, so there is nothing to carry - and attaching the replacement
   * alongside it would put the same document in a notebook twice.
   */
  const carryForwardToReplacement = async (retiredCopy: IFabFileDocument, replacementFabFileId: string) => {
    // Link the replacement BEFORE the delete unlinks the stale id: deleteFabFile filters only the
    // retired id out of `knowledgeIds`, so an entry appended here survives that same write.
    const attached = await sessionRepository.findAllWithKnowledgeId(retiredCopy.id);
    for (const notebook of attached) {
      const knowledgeIds = notebook.knowledgeIds ?? [];
      if (knowledgeIds.includes(replacementFabFileId)) continue;
      await sessionRepository.update({ id: notebook.id, knowledgeIds: [...knowledgeIds, replacementFabFileId] });
    }

    // Tags are membership, not content, so none carry over - a carried tag could otherwise enrol the
    // REPLACEMENT in a different lake by accident (matching its prefix arm). Same "nothing may reach
    // further than the retired copy did" principle as the share/other-lake checks below.
    const replacementOwnerLakes = (await prefixArmCandidateLakes()).filter(
      candidate => candidate.createdByUserId === replacementOwnerId
    );
    const carried: { name: string; strength: number }[] = [];
    for (const tag of retiredCopy.tags ?? []) {
      const name = tag?.name;
      if (typeof name !== 'string' || isDataLakeTagName(name)) continue;
      if (replacementOwnerLakes.some(candidate => matchesTagPrefixArm([name], candidate.fileTagPrefix))) continue;
      carried.push({ name, strength: typeof tag.strength === 'number' ? tag.strength : 0 });
    }
    // Grouped because pushTagsByFabFileId applies ONE strength per call, and a carried tag keeps
    // the strength a human gave it rather than being flattened to the default.
    const namesByStrength = new Map<number, string[]>();
    for (const { name, strength } of carried) {
      const names = namesByStrength.get(strength);
      if (names) names.push(name);
      else namesByStrength.set(strength, [name]);
    }
    for (const [strength, names] of namesByStrength) {
      await fabFileRepository.pushTagsByFabFileId(replacementFabFileId, names, strength);
    }
  };

  /**
   * Retire a superseded copy of a connector file: unpick it from THIS lake, then delete it outright
   * only when nothing else claims it - no other lake under either membership arm, and no share
   * granting a reader other than its owner. `replacementFabFileId` is the fresh copy that supersedes
   * this one, and inherits its links and tags; a null replacement is a file gone from its source, so
   * nothing inherits them. driveLakeIngest.ts's header covers why the two steps cannot collapse into
   * one soft-delete, why both arms have to be tested, and why the actor is the row's own owner.
   * Returns what it did, for the log.
   */
  const retireSupersededCopy = async (
    staleCopy: IFabFileDocument,
    replacementFabFileId: string | null
  ): Promise<RetireOutcome> => {
    // Per-lake by construction: clears this lake's meta-tag and prefixed content tags, nothing else.
    await dataLakeService.removeFileFromLake(
      membershipActor,
      lake,
      staleCopy.id,
      { db: { fabFiles: fabFileRepository, ...lakeMembershipAuditDb }, logger },
      { origin: 'connector' }
    );

    // Re-read AFTER the unpick, so the gate runs against the tags that actually SURVIVE it. The
    // question a hard delete must answer is "now that this file has left THIS lake, does any other
    // lake still hold it", and only the stored document answers that without re-deriving which
    // signals removeFileFromLake chose to pull.
    const retiredCopy = await fabFileRepository.findById(staleCopy.id);
    if (!retiredCopy) {
      logger.warn(`${logTag} superseded copy vanished before retire; unpicked only`, { fabFileId: staleCopy.id });
      return 'unpicked';
    }

    // The three "keep it alive" checks - a share to anyone but the owner, another lake under either
    // membership arm, no living owner - are shared verbatim with the disconnect orphan sweep; see
    // connectorCopyGate for why each one is fatal to a global, unrecoverable delete. A refused copy
    // stays live and merely unpicked: recoverable staleness beats a silent loss.
    const verdict = await evaluateConnectorCopyDeletion(retiredCopy, lake, {
      adapters: { db: { dataLakes: dataLakeRepository }, candidateLakes: await prefixArmCandidateLakes() },
      ownerStillExists,
    });
    if (!verdict.deletable) {
      const detail = { fabFileId: staleCopy.id, ...verdict.detail };
      if (verdict.reason === 'shared') {
        logger.info(`${logTag} superseded copy is shared outside its owner; unpicked only`, detail);
      } else if (verdict.reason === 'other-lake') {
        logger.info(`${logTag} superseded copy belongs to another lake; unpicked only`, detail);
      } else {
        logger.warn(`${logTag} superseded copy has no living owner; left unpicked`, detail);
      }
      return 'unpicked';
    }
    const ownerId = verdict.ownerId;

    if (replacementFabFileId) await carryForwardToReplacement(retiredCopy, replacementFabFileId);

    // Sole-lake copy: delete for real, so the chunks, search-index docs, notebook links, S3 object
    // and storage quota go with it.
    const { action } = await fabFilesService.deleteFabFile(
      ownerId,
      { id: staleCopy.id },
      {
        db: {
          fabFiles: fabFileRepository,
          fabFileChunks: fabFileChunkRepository,
          users: userRepository,
          sessions: sessionRepository,
          dataLakes: dataLakeRepository,
          ...lakeMembershipAuditDb,
        },
        storage: getFilesStorage(),
        onDeleteComplete: async (_fabFile, size) => {
          reclaimedBytesByUserId.set(ownerId, (reclaimedBytesByUserId.get(ownerId) ?? 0) + size);
        },
        searchIndex: selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined,
        logger,
        // This is the sole-lake-copy hard delete, reached only after removeFileFromLake above
        // already unpicked it from `lake` and confirmed no other lake claims it - so this
        // normally finds zero remaining membership. Wired anyway so a future claim this poll
        // does not yet know about still gets a 'removed' row instead of a silent gap.
        origin: 'connector',
      }
    );
    if (action !== 'deleted') {
      logger.warn(`${logTag} superseded copy could not be deleted; left unpicked`, { fabFileId: staleCopy.id, action });
    }
    return action;
  };

  // Best-effort, and deliberately non-fatal: the files are already gone, so a failed quota write
  // must not throw the whole reconcile into an SQS retry that would re-walk and re-ingest.
  const flushReclaimedStorage = async () => {
    if (reclaimedBytesByUserId.size === 0) return;
    // Drain before deducting: this also runs from a `finally`, and a partial failure must not leave
    // bytes staged for a later flush to deduct a second time.
    const pending = [...reclaimedBytesByUserId.entries()];
    reclaimedBytesByUserId.clear();
    for (const [ownerId, bytes] of pending) {
      if (bytes <= 0) continue;
      try {
        // Load the owner HERE, never the document read at the top of the handler. changeStorageSize
        // mutates in memory and save() writes an ABSOLUTE currentStorageSize, so a document read
        // before the loop would overwrite the increments every storage.upload in it just made
        // through objectCreated - which loads and saves its own copy of the same user. Same reason
        // bulk-delete.ts re-reads immediately before deducting; the transaction makes this
        // read-modify-write conflict-checked rather than merely narrow.
        await withTransaction(async () => {
          const owner = await User.findById(ownerId);
          if (!owner) return;
          await changeStorageSize(owner, -bytes);
          await owner.save();
        });
      } catch (e) {
        logger.error(`${logTag} failed to deduct reclaimed storage`, {
          ownerId,
          bytes,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  return {
    retireSupersededCopy,
    flushReclaimedStorage,
    stagedReclaimFor: (userId: string) => reclaimedBytesByUserId.get(userId) ?? 0,
  };
}

export async function ingestLakeFile(args: {
  data: IFabFile;
  ability: Parameters<typeof createFabFile>[1];
  lake: IngestLake;
  membershipActor: ConnectorMembershipActor;
  batchId: string;
  bytes: Buffer;
  fileKey: string;
  logger: Logger;
}) {
  const { data, ability, lake, membershipActor, batchId, bytes, fileKey, logger } = args;
  const fabFile = await createFabFile(data, ability);

  // This door stamps the lake's meta-tag directly into `tags` at creation (above) rather than
  // going through `addFileToLake` - there is no FabFile yet for that door to gate on when the
  // tags are decided - so the membership event has to be recorded explicitly here instead of
  // riding along inside that shared write.
  await dataLakeService.recordLakeMembershipChange(
    { actor: membershipActor, lake, fabFileId: fabFile.id, action: 'added', origin: 'connector' },
    { db: lakeMembershipAuditDb, logger }
  );

  // Manifest entry BEFORE the bytes land - the upload fires objectCreated synchronously and its
  // downstream claims need this entry to already exist (ordering is load-bearing; see
  // driveLakeIngest.ts's header).
  await dataLakeBatchRepository.appendFiles(batchId, [
    { fabFileId: fabFile.id, fileName: data.fileName, relativePath: data.relativePath, status: 'pending' },
  ]);

  await getFilesStorage().upload(bytes, fileKey, { ContentType: data.mimeType });

  // Confirm the upload SYNCHRONOUSLY, right here - not left to the async S3 objectCreated
  // event. A resumed slice subtracts only non-'pending' rows precisely so a FabFile whose
  // upload threw is not mistaken for an uploaded one; a continuation enqueued moments after
  // this call cannot be trusted to race that event first.
  await fabFileRepository.markUploaded(fabFile.id);
  return fabFile;
}

/**
 * Close out the batch a chain shares across its slices: re-plan `totalFiles` to what the chain
 * ACTUALLY produced (manifest entries + skips) and nudge the finalize gate. driveLakeIngest.ts's
 * `settleChainedBatch` doc covers why every early exit has to reach this.
 */
export async function settleLakeIngestBatch(batchId: string, logger: Logger): Promise<void> {
  const current = await dataLakeBatchRepository.findById(batchId);
  if (!current) return;
  // Skipped files can double up (objectCreated marks a skip on an ALREADY-appended manifest entry
  // for e.g. audio/enableAutoChunk-off), so only the handler's own no-manifest skip() needs adding
  // back to the manifest count. deferredFiles is what the chain planned minus what it produced -
  // never negative, since a mid-chain walk only ever raises totalFiles, never lowers it below produced.
  const produced = (current.files?.filter(f => f.status !== 'skipped').length ?? 0) + (current.skippedFiles ?? 0);
  const deferredFiles = Math.max(0, current.totalFiles - produced);
  const settled =
    produced === current.totalFiles
      ? current
      : await dataLakeBatchRepository.setTotalFilesIfActive(batchId, produced, deferredFiles);
  await finalizeBatchIfComplete(settled ?? current, logger);
}

/**
 * The admission and origin gates a connector sync passes before it adds files; throws BadRequestError
 * on refusal. Once per sync: the lake and owner-to-be are the same for every candidate.
 */
export async function assertConnectorLakeWrite(
  lake: IngestLake,
  membershipActor: ConnectorMembershipActor,
  ownerId: string,
  logger: Logger
): Promise<void> {
  // Both gates below read the same admin/scoped settings repositories; the second also needs
  // dataLakes for the origin check.
  const gateDb = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
  await dataLakeService.assertLakeAdmission([lake], [{ userId: ownerId }], { db: gateDb, logger });

  // Covers ADDITIONS only, so a caller's retire sweep runs unaffected by origin - refusing a removal
  // would strand the lake out of sync with no way to converge.
  //
  // isAdmin is synthetic (a connector acts as its connecting user) - it short-circuits the manage
  // rung (canManageLake in manageRule.ts), so what this call actually adds beyond that is the origin
  // check plus a newly-caught purged lake (`!lake`). The origin check itself is privilege-blind, so
  // the synthetic admin does not weaken it.
  await dataLakeService.assertCanWriteDataLakeTags(membershipActor, [lake.datalakeTag], {
    db: { dataLakes: dataLakeRepository, ...gateDb },
    logger,
    unattended: true,
  });
}
