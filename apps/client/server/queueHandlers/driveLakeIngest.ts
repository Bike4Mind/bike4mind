import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  User,
  adminSettingsRepository,
  changeStorageSize,
  dataLakeRepository,
  dataLakeBatchRepository,
  fabFileChunkRepository,
  fabFileRepository,
  orgGoogleDriveConnectionRepository,
  scopedSettingsRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import {
  DATALAKE_TAG_STRENGTH,
  KnowledgeType,
  FabFileSourceType,
  isDataLakeTagName,
  matchesTagPrefixArm,
  type IUserDocument,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { createFabFile } from '@server/managers/fabFileManager';
import defineAbilitiesFor from '@server/auth/ability';
import { getFilesStorage } from '@server/utils/storage';
import { getValidConnectionDriveAccessToken } from '@server/integrations/google/drive/common';
import { createDriveClient } from '@server/integrations/google/drive/driveClient';
import { walkFolder, fetchDriveFileContent } from '@server/integrations/google/drive/driveContent';
import { finalizeBatchIfComplete } from '@server/queueHandlers/dataLakeBatchProgress';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { z, ZodError } from 'zod';

const Payload = z.object({ connectionId: z.string(), redriveCount: z.number().int().min(0).default(0) });

// A claim loser re-enqueues itself (with a delay) so a GENUINE second sync - files added to the
// folder while a long run is mid-loop - isn't silently dropped until the next scheduled poll.
// Bounded so a permanently-losing message can't spin: past this many redrives we give up and let
// the next real sync pick the files up. Delay x max stays comfortably past the handler's 10-minute
// in-flight ceiling.
const MAX_INGEST_REDRIVES = 12;
const INGEST_REDRIVE_DELAY_SECONDS = 90;

// Per-file hard cap. Files are fetched and uploaded ONE at a time (only one buffer is ever live),
// so this bounds peak memory well under the ingest queue Lambda's 1024 MB default. An oversized
// file is skipped-and-counted (before the download when the size is known up front), so the failure
// mode is a skipped file rather than an OOM that kills the whole run mid-loop. A streaming path for
// genuinely large files is the "very large folders" follow-up.
const MAX_INGEST_FILE_BYTES = 50 * 1024 * 1024;

// Per-sync candidate cap. A folder whose candidate count (adds + re-ingests) can't be fetched+uploaded
// within the queue Lambda's hard 10-minute ceiling would time out mid-loop EVERY run - a deterministic
// (not transient) failure - and since the retry re-creates FabFiles for the un-uploaded tail (dedup
// excludes `pending`), the duplicates accumulate without the ingest ever converging. Refuse such a
// folder up front, BEFORE any membership write, batch, or FabFile exists, so no partial state is ever
// created (not even a premature removal). Full support for very large folders
// (batch adoption / a streaming path) is the documented #1589 follow-up; until then this fails fast with
// a clear message instead of spiralling. Sized well under the ~600-1800 files a 10-min sequential run
// could realistically move.
const MAX_INGEST_CANDIDATES = 1500;

/**
 * Has a Drive file changed since it was ingested? `md5Checksum` is exact, but Google Editors files
 * (Docs/Sheets/Slides) carry no md5, so fall back to `modifiedTime` for those. Conservative by
 * design: when neither signal can be compared (a pre-provenance row, or a file Drive reports with
 * neither field) it returns false, so a re-sync never churns a file it cannot PROVE is stale.
 * modifiedTime uses strict-newer so a re-listed-but-unedited file (same timestamp) is unchanged.
 */
export function hasDriveFileChanged(
  prior: { driveMd5Checksum?: string; driveModifiedTime?: Date | string },
  fresh: { md5Checksum?: string; modifiedTime?: string }
): boolean {
  if (fresh.md5Checksum && prior.driveMd5Checksum) {
    return fresh.md5Checksum !== prior.driveMd5Checksum;
  }
  if (fresh.modifiedTime && prior.driveModifiedTime) {
    return new Date(fresh.modifiedTime).getTime() > new Date(prior.driveModifiedTime).getTime();
  }
  return false;
}

/**
 * Background reconcile of an org Google Drive folder against a data lake (#1589, #1591). Walks the
 * folder, diffs it against the files this connection has already ingested, and applies the delta:
 * ADD a new file, RE-INGEST an edited one, and REMOVE from the lake one that is gone from the folder.
 * Adds/re-ingests fetch and upload ONE file at a time - creating a lake-tagged FabFile and its
 * batch-manifest entry BEFORE the bytes land - and let the existing S3 objectCreated -> chunk ->
 * vectorize -> finalize pipeline do the rest. Both the manual Re-sync button and the scheduled poll
 * cron (driveLakeResyncPoll) enqueue onto this one handler, so there is a single delta-aware apply path.
 *
 * Apply order is deliberate. The single-sync cap is enforced FIRST, before any membership write, so an
 * over-cap folder is refused with nothing changed (an early removal on a run that then bails would evict
 * files it never re-ingests). Genuine deletes (gone from the folder) are then unpicked up front - they
 * have no replacement pending, so nothing is lost by removing them early. An EDITED file's stale copy is
 * NOT retired until its fresh replacement has been uploaded in the loop below: retiring it up front would
 * evict a working lake member for good on any run where the re-fetch then fails a deterministic gate
 * (oversized / unsupported / export-too-large), since that skip creates no replacement.
 *
 * Retiring an edited file's stale copy is two steps, in this order, and the order is the point. FIRST an
 * unpick from THIS lake (removeFileFromLake), which is per-lake by construction - see the reserved-namespace
 * note in lakeMembership.ts. THEN, only when NO OTHER LAKE still claims the copy, a full delete through
 * fabFileService.deleteFabFile. A superseded Drive doc must leave the owner's Files entirely (its pre-edit
 * content must not stay retrievable, and one orphan copy per edit must not accumulate with its chunks,
 * embeddings, S3 object and storage quota) - but a copy a human curated into a SECOND lake must not be
 * yanked out of it by a background poll. A blanket soft-delete would do exactly that: `deletedAt` is
 * filtered by EVERY lake's read path, so a per-lake operation would have become a global one. Keeping the
 * membership unpick and gating the delete preserves the per-lake invariant instead of racing it.
 *
 * That gate has to test BOTH arms of the one membership predicate (buildDataLakeMembershipFilter), which is
 * what dataLakeService.findOtherLakeClaims does: the `datalake:` meta-tag, AND a `fileTagPrefix` match on a
 * file the other lake's creator owns. A meta-tag-only gate is a trap, because a file curated into a second
 * lake through that lake's PREFIX carries no meta-tag for it - the gate would read "nobody else wants this"
 * and delete a full member out of a lake it never looked at.
 *
 * The gate also refuses to delete a copy anyone but its owner can read - a direct user share, a group share,
 * or isGlobalRead. The delete is global, so it would take the share vector with it, and the replacement is
 * minted for connection.connectedBy alone and carries none, so there is nothing to hand the sharee instead;
 * they would be left with a notebook reference that getAccessibleFiles silently drops. The trade is the same
 * one the other-lake branch makes: a shared copy is left unpicked-but-alive, so it does accumulate one stale
 * orphan per edit (it drops out of findByDriveConnectionIdInDataLake once unpicked, and no later poll revisits
 * it), and the sharee reads pre-edit content. Recoverable staleness beats a silent, unrecoverable loss of
 * access. If Drive-lake files turn out never to be shared directly, this branch simply never fires.
 *
 * The full delete goes through fabFileService.deleteFabFile rather than a bare `deletedAt` stamp because
 * only that path also reaps the chunks, the per-model search-index docs, the session (notebook) links, the
 * S3 object and the owner's counted storage. A bare stamp leaves all of it billed and orphaned forever -
 * nothing reaps soft-deleted FabFiles outside whole-lake teardown. Two of those the user would MISS, so
 * they are carried onto the fresh copy first (carryForwardToReplacement): the notebook attachments, and the
 * tags a human applied by hand. Otherwise a one-character edit in Drive silently detaches the doc from
 * every notebook holding it and drops its tags.
 *
 * The delete's actor is the retired ROW'S OWN owner, not `connection.connectedBy` - a reconnect re-stamps
 * connectedBy (drive-sync.ts), and running as a non-owner would either deny (accumulating one orphan copy
 * per edit) or take deleteFabFile's self-unshare branch and mutate the file instead of reaping it.
 *
 * A genuine delete (gone from the folder) keeps the membership-only unpick and never deletes - the file left
 * the folder but the owner keeps their copy, which is not superseded by anything.
 *
 * OUT OF SCOPE for E1 (#1589 follow-ups): a rename/move in Drive (md5 unchanged, only modifiedTime
 * moves) is classified unchanged, so the stale fileName/relativePath is not reconciled; a
 * permanently-unsupported file (unsupported type, oversized Editors export) is never a durable member,
 * so it re-appears as a candidate and re-skips on every poll - noise, not harm, but it never converges;
 * and an unpicked file keeps its `driveConnectionId`/`sourceLakeId`, so one that leaves the folder and
 * later returns is re-ingested as a brand-new FabFile while the unpicked original lingers in the owner's
 * Files.
 *
 * Ordering is load-bearing. `storage.upload` fires `objectCreated` synchronously, which walks
 * objectCreated -> chunk -> vectorize; each stage advances batch progress by claiming its manifest
 * file (claimFileStatus). If the manifest entry does not exist yet those claims silently no-op, so
 * vectorizedFiles never increments and the batch never crosses its finalize threshold. Hence the
 * per-file `appendFiles` AHEAD of `storage.upload`, not a single append after the loop.
 *
 * totalFiles is seeded with the candidate count (adds + re-ingests); a skip (oversized / unsupported
 * / transient fetch error) is folded into `skippedFiles` as it happens, so `vectorized + failed +
 * skipped` still reaches totalFiles exactly (finalizeBatchIfComplete's gate) without the ingestable
 * count being known up front. Removals happen outside the batch (immediate lake-membership pulls).
 *
 * KNOWN GAP (#1589 follow-up): a throw part-way through the loop is rethrown for SQS retry, and the
 * retry re-walks and re-creates FabFiles for files it had not uploaded yet (the dedup excludes
 * `pending` rows), so a transient mid-loop failure can duplicate the un-uploaded tail. The
 * per-connection `syncing` claim below closes the concurrent double-run case; full retry-idempotency
 * (adopting the in-flight batch) is deferred.
 */
export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  let connectionId: string | undefined;
  let claimed = false;
  try {
    const payload = Payload.parse(JSON.parse(event.Records[0].body));
    connectionId = payload.connectionId;
    const { redriveCount } = payload;
    logger.updateMetadata({ handler: 'driveLakeIngest', connectionId });

    const connection = await orgGoogleDriveConnectionRepository.findById(connectionId);
    if (!connection) {
      logger.warn('[driveLakeIngest] connection not found; dropping', { connectionId });
      return;
    }

    // Serialize ingest per connection: two rapid POSTs (a double-clicked button, a retried request)
    // both walk and both create a full set of FabFiles otherwise, since the driveFileId dedup can't
    // help while the first run's rows are still `pending`. The loser here is a cheap no-op.
    claimed = await orgGoogleDriveConnectionRepository.claimForSync(connectionId);
    if (!claimed) {
      // Someone else holds the claim. If a real ingest is in flight ('syncing'), DEFER this run by
      // re-enqueuing with a delay so a genuine second sync (new files added mid-run) isn't dropped -
      // bounded so it can't spin. If instead the connection is in an error state (claimForSync won't
      // claim over one), there's nothing to defer behind, so just drop the duplicate.
      const current = await orgGoogleDriveConnectionRepository.findById(connectionId);
      if (current?.status === 'syncing' && redriveCount < MAX_INGEST_REDRIVES) {
        await sendToQueue(
          Resource.driveLakeIngestQueue.url,
          { connectionId, redriveCount: redriveCount + 1 },
          INGEST_REDRIVE_DELAY_SECONDS
        );
        logger.info('[driveLakeIngest] another sync in flight; deferred', {
          connectionId,
          redriveCount: redriveCount + 1,
        });
      } else {
        logger.info('[driveLakeIngest] could not claim (not syncing or redrive exhausted); skipping', {
          connectionId,
          status: current?.status,
          redriveCount,
        });
      }
      return;
    }

    const lake = await dataLakeRepository.findById(connection.targetDataLakeId);
    if (!lake) {
      logger.warn('[driveLakeIngest] target data lake not found; dropping', { connectionId });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
      });
      return;
    }
    const user = await User.findById(connection.connectedBy);
    if (!user) {
      logger.warn('[driveLakeIngest] connecting user not found; dropping', { connectionId });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
      });
      return;
    }
    const ability = defineAbilitiesFor(user as unknown as IUserDocument);

    // Prefer the connection's own token; falls back to the connecting user's (D not built yet).
    // A credential failure marks the connection credential_error and throws so SQS retries -> DLQ.
    const accessToken = await getValidConnectionDriveAccessToken(connectionId, connection.organizationId);
    const drive = createDriveClient(accessToken);

    // 1) Walk the folder tree (one level per Drive call, recursed). De-dup by driveFileId: a legacy
    //    multi-parented Drive file surfaces once per parent inside the walked subtree, and a duplicate
    //    would otherwise double-ingest (two FabFiles for one add) and double-remove (the second
    //    removeFileFromLake throws NotFoundError, aborting the reconcile mid-prune).
    const walkedRaw = await walkFolder(drive, connection.driveFolderId);
    const walkedIds = new Set<string>();
    const walked = walkedRaw.filter(f => {
      if (walkedIds.has(f.id)) return false;
      walkedIds.add(f.id);
      return true;
    });

    // 2) Diff the walk against everything THIS connection has in the lake, keyed by the stable
    //    driveFileId, and split into ADD (new), UPDATE (same id, moved md5/modifiedTime), and
    //    REMOVE (in the lake, gone from the folder). The stored set is the connection's own files
    //    so a re-sync never touches files added by other means.
    const datalakeTag = lake.datalakeTag;
    const existingDocs = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, datalakeTag);
    //    One driveFileId can map to SEVERAL stored copies: `main`'s add-only handler had no walk
    //    de-dup, so a multi-parented Drive file or an SQS retry after a partial run could already
    //    have created a second non-pending row. Key to a list (not last-wins) so those duplicates
    //    are visible here - otherwise they stay lake members holding pre-edit content that no
    //    future walk can ever see again.
    const existingByDriveId = new Map<string, (typeof existingDocs)[number][]>();
    for (const doc of existingDocs) {
      if (!doc.driveFileId) continue;
      const copies = existingByDriveId.get(doc.driveFileId);
      if (copies) copies.push(doc);
      else existingByDriveId.set(doc.driveFileId, [doc]);
    }
    // Newest-first within each id: the head anchors change detection (it is what the last successful
    // ingest wrote), and the tail is duplicates. Sorted rather than left in find() order so the
    // representative is deterministic - an unsorted query could otherwise diff against an older row
    // and re-ingest a file that is not actually stale.
    for (const copies of existingByDriveId.values()) {
      copies.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    const newestCopyOf = (driveFileId: string) => existingByDriveId.get(driveFileId)?.[0];
    const pureAdds = walked.filter(f => !existingByDriveId.has(f.id));
    const changed = walked.filter(f => {
      const prior = newestCopyOf(f.id);
      return prior != null && hasDriveFileChanged(prior, f);
    });
    let removed = existingDocs.filter(doc => doc.driveFileId != null && !walkedIds.has(doc.driveFileId));

    // Transient-glitch guard: an EMPTY walk while the lake still holds this connection's files is
    // far likelier a permission blip or a Drive hiccup than a real empty-out. walkFolder throws on a
    // listing error (so an empty result is a genuine "no children", not a truncated one), but
    // pruning an entire lake on one empty pass is too destructive to trust - refuse it. A real
    // empty-out still reconciles once even one file remains to anchor the walk as trustworthy.
    if (walked.length === 0 && existingDocs.length > 0) {
      logger.warn('[driveLakeIngest] folder walk returned empty while lake holds files; skipping prune', {
        connectionId,
        existing: existingDocs.length,
      });
      removed = [];
    }

    // Adds and edited files both ingest fresh; an edited file's stale copy is retired in the loop
    // below, only after its replacement is uploaded (never up front - see the header for why).
    const candidates = [...pureAdds, ...changed];

    // A trusted system reconcile acts as admin for membership writes (canManageLake): the connection
    // was authorized by an org owner/manager at connect time (verifyOrgAccess). Pass the resolved lake
    // itself (not a hand-projection) so `organizationId` reaches the org-manageable manage rung.
    const membershipActor = { userId: connection.connectedBy, isAdmin: true };
    const recomputeStats = () =>
      dataLakeService.recomputeLakeStats(lake, {
        db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
      });

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
      (candidateLakesOnce ??= dataLakeService.loadPrefixArmCandidateLakes(
        [connection.connectedBy, ...existingDocs.map(doc => doc.userId)],
        { db: { dataLakes: dataLakeRepository } }
      ));

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
    const carryForwardToReplacement = async (
      retiredCopy: (typeof existingDocs)[number],
      replacementFabFileId: string
    ) => {
      // Link the replacement BEFORE the delete unlinks the stale id: deleteFabFile filters only the
      // retired id out of `knowledgeIds`, so an entry appended here survives that same write.
      const attached = await sessionRepository.findAllWithKnowledgeId(retiredCopy.id);
      for (const notebook of attached) {
        const knowledgeIds = notebook.knowledgeIds ?? [];
        if (knowledgeIds.includes(replacementFabFileId)) continue;
        await sessionRepository.update({ id: notebook.id, knowledgeIds: [...knowledgeIds, replacementFabFileId] });
      }

      // A meta-tag is membership, not content: this lake's was just pulled, the gate proved no other
      // lake holds one, and a non-canonical leftover names no lake at all. None of them carry over.
      //
      // Nor may a carried tag enrol the REPLACEMENT in a lake of its own. The gate cleared the
      // RETIRED copy's owner, and after a reconnect the replacement's owner differs (it is minted as
      // connection.connectedBy), so a tag that conferred nothing there can still match a prefix arm
      // of a lake the new owner created. Dropping those keeps this a pure carry-over, and keeps it
      // out of the membership doors (reconcileLakeTags) a real join would have to go through.
      const replacementOwnerLakes = (await prefixArmCandidateLakes()).filter(
        candidate => candidate.createdByUserId === connection.connectedBy
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
     * Retire a superseded copy of a Drive file: unpick it from THIS lake, then delete it outright
     * only when nothing else claims it - no other lake under either membership arm, and no share
     * granting a reader other than its owner. `replacementFabFileId`
     * is the fresh copy that supersedes this one, and inherits its links and tags. The header covers
     * why the two steps cannot collapse into one soft-delete, why both arms have to be tested, and
     * why the actor is the row's own owner. Returns what it did, for the log.
     */
    const retireSupersededCopy = async (staleCopy: (typeof existingDocs)[number], replacementFabFileId: string) => {
      // Per-lake by construction: clears this lake's meta-tag and prefixed content tags, nothing else.
      await dataLakeService.removeFileFromLake(membershipActor, lake, staleCopy.id, {
        db: { fabFiles: fabFileRepository },
      });

      // Re-read AFTER the unpick, so the gate runs against the tags that actually SURVIVE it. The
      // question a hard delete must answer is "now that this file has left THIS lake, does any other
      // lake still hold it", and only the stored document answers that without re-deriving which
      // signals removeFileFromLake chose to pull.
      const retiredCopy = await fabFileRepository.findById(staleCopy.id);
      if (!retiredCopy) {
        logger.warn('[driveLakeIngest] superseded copy vanished before retire; unpicked only', {
          fabFileId: staleCopy.id,
        });
        return 'unpicked' as const;
      }

      // A grant to anyone other than the owner is a claim too, and the same argument the other-lake
      // branch makes below applies: the delete is global, so it would take the share vector with it
      // and leave the sharee holding a notebook reference they can no longer resolve - silently,
      // because getAccessibleFiles just drops an id the reader has no grant on. The replacement
      // carries no shares (it is minted for connection.connectedBy alone), so there is nothing to
      // hand them instead. Keep the retired copy alive and merely unpicked: the sharee sees the
      // PRE-EDIT content, which they can re-request, rather than losing the file outright.
      const shareClaims = {
        users: (retiredCopy.users ?? []).length,
        groups: (retiredCopy.groups ?? []).length,
        globalRead: !!retiredCopy.isGlobalRead,
      };
      if (shareClaims.users > 0 || shareClaims.groups > 0 || shareClaims.globalRead) {
        logger.info('[driveLakeIngest] superseded copy is shared outside its owner; unpicked only', {
          fabFileId: staleCopy.id,
          ...shareClaims,
        });
        return 'unpicked' as const;
      }

      const tagNames = (retiredCopy.tags ?? [])
        .map(tag => tag?.name)
        .filter((name): name is string => typeof name === 'string');

      const claims = await dataLakeService.findOtherLakeClaims({ userId: retiredCopy.userId, tagNames }, lake, {
        db: { dataLakes: dataLakeRepository },
        candidateLakes: await prefixArmCandidateLakes(),
      });
      if (dataLakeService.hasOtherLakeClaim(claims)) {
        // Someone curated this file into another lake - by that lake's meta-tag, or by a tag under
        // its fileTagPrefix. It leaves the Drive lake and keeps living there; deleting it would evict
        // it from a lake this poll has no business touching. The consequence, deliberately: that lake
        // keeps the PRE-EDIT copy, because the fresh replacement is tagged into this lake only.
        // Propagating an edit into a hand-curated lake is a decision for whoever curated it, not for
        // a background poll - and holding stale content is recoverable (re-add the new copy), whereas
        // a silent eviction is not.
        logger.info('[driveLakeIngest] superseded copy belongs to another lake; unpicked only', {
          fabFileId: staleCopy.id,
          otherLakeTags: claims.metaTagNames,
          otherLakeIds: claims.prefixArmLakes.map(other => other.id),
        });
        return 'unpicked' as const;
      }

      const ownerId = retiredCopy.userId;
      if (!ownerId || !(await ownerStillExists(ownerId))) {
        logger.warn('[driveLakeIngest] superseded copy has no living owner; left unpicked', {
          fabFileId: staleCopy.id,
          ownerId,
        });
        return 'unpicked' as const;
      }

      await carryForwardToReplacement(retiredCopy, replacementFabFileId);

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
          },
          storage: getFilesStorage(),
          onDeleteComplete: async (_fabFile, size) => {
            reclaimedBytesByUserId.set(ownerId, (reclaimedBytesByUserId.get(ownerId) ?? 0) + size);
          },
          searchIndex: selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined,
        }
      );
      if (action !== 'deleted') {
        logger.warn('[driveLakeIngest] superseded copy could not be deleted; left unpicked', {
          fabFileId: staleCopy.id,
          action,
        });
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
          // Load the owner HERE, never the document read at the top of this handler. changeStorageSize
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
          logger.error('[driveLakeIngest] failed to deduct reclaimed storage', {
            connectionId,
            ownerId,
            bytes,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    };

    // 3) Enforce the single-sync cap FIRST, before any membership write. An over-cap folder would time
    //    out mid-loop every attempt and accumulate duplicates (see MAX_INGEST_CANDIDATES); refusing here
    //    - a deterministic condition, so return cleanly rather than DLQ-ing a retry - guarantees nothing
    //    is changed on a run that cannot ingest, not even an early removal that would strand files.
    if (candidates.length > MAX_INGEST_CANDIDATES) {
      logger.warn('[driveLakeIngest] folder exceeds single-sync ingest cap; refusing', {
        connectionId,
        candidates: candidates.length,
        cap: MAX_INGEST_CANDIDATES,
      });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
        lastError: `Folder has ${candidates.length} files to sync (new + re-synced), over the ${MAX_INGEST_CANDIDATES}-file limit for a single sync. Split it into subfolders and connect them separately.`,
      });
      return;
    }

    // 4) Apply genuine deletes now: a file gone from the folder has no replacement pending, so the
    //    membership-only unpick loses nothing (the FabFile stays in the owner's Files, chunks untouched).
    //    Stats recompute is deferred to the end so it also reflects the stale copies retired in the loop.
    for (const doc of removed) {
      await dataLakeService.removeFileFromLake(membershipActor, lake, doc.id, {
        db: { fabFiles: fabFileRepository },
      });
    }

    let retired = 0;

    // Everything that retires a copy runs inside this `try`, step 4b included, so that a throw part
    // way through EITHER the duplicate sweep or the ingest loop still settles what the committed
    // deletes changed: the reclaimed bytes (the retry re-walks without seeing those files, so they
    // would stay counted against their owners forever) and the lake's stats.
    try {
      // 4b) Retire pre-existing duplicates: extra copies of a driveFileId that is STILL in the folder,
      //     left behind by the add-only handler this replaced (a multi-parented file, or an SQS retry
      //     after a partial run). They hold pre-edit content, stay lake members, and are invisible to
      //     every future walk because the newest copy shadows them. Safe to retire up front and not
      //     after an upload: the newest copy stays live either way, so nothing is left without a member.
      //     A driveFileId gone from the folder is skipped here - all of its copies are already in
      //     `removed` above.
      for (const [driveFileId, copies] of existingByDriveId) {
        if (!walkedIds.has(driveFileId) || copies.length < 2) continue;
        //   The newest copy is what supersedes every duplicate, so it inherits their notebook links
        //   and tags. If this driveFileId is ALSO an edit, the loop below carries that chain onward
        //   from the newest copy to the fresh upload.
        for (const duplicate of copies.slice(1)) {
          await retireSupersededCopy(duplicate, copies[0].id);
          retired++;
        }
      }

      if (candidates.length === 0) {
        logger.info('[driveLakeIngest] reconciled; no files to ingest', {
          walked: walked.length,
          existing: existingDocs.length,
          removed: removed.length,
          updated: changed.length,
          retired,
        });
        await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
          status: 'connected',
          lastPolledAt: new Date(),
        });
        return;
      }

      // The admission contract (#1680) for the lake this sync is JOINING every candidate into. This
      // door resolves its lake server-side and stamps the meta-tag itself (below), and it creates its
      // FabFiles through the manager's direct `FabFile.create` rather than
      // `fabFileService.createFabFile` - so neither the meta-tag chokepoint nor the service gate ever
      // sees it. Structurally the same unwired door `generate-presigned-urls-batch` needed its own
      // explicit call for.
      //
      // Once per sync, before the batch: the lake and the owner-to-be are the same for every
      // candidate, so a refusal is a property of the connection, not of any one file. No FabFile
      // exists yet, so the subject is the owner-to-be and the gate predicts from THEIR chunk policy.
      // It sits after the reconcile's removals on purpose - a file gone from the folder is retired
      // whether or not the lake will accept new content, exactly as on the zero-candidate return.
      //
      // A refusal is DETERMINISTIC - retrying re-reads the same lever and the same policy - so it is
      // recorded as guidance and returned cleanly rather than rethrown into an SQS retry that would
      // spin to the DLQ. Same treatment as the candidate cap above.
      try {
        await dataLakeService.assertLakeAdmission([lake], [{ userId: connection.connectedBy }], {
          db: { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
          logger,
        });
      } catch (admissionError) {
        if (!(admissionError instanceof BadRequestError)) throw admissionError;
        logger.warn('[driveLakeIngest] data lake refused this content at admission; refusing the sync', {
          connectionId,
          dataLakeId: lake.id,
          candidates: candidates.length,
        });
        await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
          status: 'connected',
          lastPolledAt: new Date(),
          lastError: admissionError.message,
        });
        return;
      }

      // 5) Create the batch. totalFiles is the candidate count; a per-file skip is folded into
      //    skippedFiles as it happens (see the loop below), so the finalize gate is still reached exactly.
      //    totalSizeBytes is best-effort - Google Editors files carry no size at list time.
      const batch = await dataLakeBatchRepository.create({
        dataLakeId: connection.targetDataLakeId,
        userId: connection.connectedBy,
        status: 'processing',
        conflictResolution: 'skip',
        totalFiles: candidates.length,
        totalSizeBytes: candidates.reduce((sum, f) => sum + (f.size ?? 0), 0),
        uploadedFiles: 0,
        chunkedFiles: 0,
        vectorizedFiles: 0,
        failedFiles: 0,
        processingFailedFiles: 0,
        skippedFiles: 0,
        uploadedSizeBytes: 0,
        files: [],
        appliedTags: [],
        startedAt: new Date(),
        wantsTaxonomy: false,
        taxonomyStatus: 'none',
      });

      const applyFallbackTags = dataLakeService.createDataLakeFallbackTagger({
        db: { dataLakes: dataLakeRepository },
        logger,
      });
      const storage = getFilesStorage();
      let uploaded = 0;
      let skipped = 0;

      const skip = async (driveFileId: string, reason: string, extra?: Record<string, unknown>) => {
        skipped++;
        await dataLakeBatchRepository.incrementCounter(batch.id, 'skippedFiles');
        logger.info('[driveLakeIngest] skipping file', { driveFileId, reason, ...extra });
      };

      // 6) One file at a time: size-gate -> fetch -> create FabFile -> append its manifest entry ->
      //    upload. Only one file's bytes are ever live, and the manifest entry precedes the upload so
      //    the objectCreated/chunk/vectorize claims the upload fires can find it (see header).
      for (const file of candidates) {
        // Native binaries carry a size, so skip the oversized ones BEFORE spending a Drive download.
        // Editors exports have no size here; they are bounded by Drive's own ~10 MB export cap
        // (surfaced as export_too_large) plus the post-fetch guard below.
        if (file.size != null && file.size > MAX_INGEST_FILE_BYTES) {
          await skip(file.id, 'oversized', { size: file.size });
          continue;
        }

        const result = await fetchDriveFileContent(drive, file);
        if (!result.ok) {
          await skip(file.id, result.reason);
          continue;
        }
        if (result.bytes.length > MAX_INGEST_FILE_BYTES) {
          await skip(file.id, 'oversized_after_fetch', { size: result.bytes.length });
          continue;
        }

        const { bytes, mimeType } = result;
        const ext = mime.extension(mimeType);
        const fileKey = `${uuidv4()}${ext ? `.${ext}` : ''}`;
        const tags = await applyFallbackTags([{ name: datalakeTag, strength: DATALAKE_TAG_STRENGTH }]);

        const fabFile = await createFabFile(
          {
            userId: connection.connectedBy,
            filePath: fileKey,
            fileSize: bytes.length,
            fileName: file.name,
            mimeType,
            type: KnowledgeType.FILE,
            tags,
            batchId: batch.id,
            relativePath: file.relativePath,
            status: 'pending',
            // Drive provenance (#1589): dedup key + change detection + source.
            sourceType: FabFileSourceType.GOOGLE_DRIVE,
            driveFileId: file.id,
            ...(file.modifiedTime && { driveModifiedTime: new Date(file.modifiedTime) }),
            ...(file.md5Checksum && { driveMd5Checksum: file.md5Checksum }),
            sourceLakeId: connection.targetDataLakeId,
            driveConnectionId: connectionId,
          },
          ability
        );

        // Manifest entry BEFORE the bytes land - the upload fires objectCreated synchronously and its
        // downstream claims need this entry to already exist (ordering is load-bearing; see header).
        await dataLakeBatchRepository.appendFiles(batch.id, [
          {
            fabFileId: fabFile.id,
            fileName: file.name,
            relativePath: file.relativePath,
            status: 'pending',
          },
        ]);

        await storage.upload(bytes, fileKey, { ContentType: mimeType });
        uploaded++;

        // Edited file: its fresh replacement is now durably uploaded, so retire the superseded copy
        // (see retireSupersededCopy, and the header for the invariants it keeps). Done PER-FILE right
        // after the upload, not batched at the end: a later file throwing then leaves every
        // already-processed edit fully reconciled (old retired, new uploaded) instead of stranding the
        // old copy as a duplicate lake member the next walk can no longer see (both share
        // driveFileId). Only the newest copy is left to retire here - any older siblings went in 4b.
        const staleCopy = newestCopyOf(file.id);
        if (staleCopy) {
          await retireSupersededCopy(staleCopy, fabFile.id);
          retired++;
        }
      }

      logger.info('[driveLakeIngest] uploaded; pipeline will chunk+vectorize', {
        connectionId,
        batchId: batch.id,
        walked: walked.length,
        existing: existingDocs.length,
        removed: removed.length,
        updated: changed.length,
        uploaded,
        skipped,
        retired,
      });

      // A batch that only skipped (or whose uploads all vectorized before the loop ended) has already
      // crossed the finalize gate, but nothing re-checks it - our skip increments don't fire the
      // pipeline's finalize. Nudge it once; a guarded no-op if uploads are still in flight.
      await finalizeBatchIfComplete(await dataLakeBatchRepository.findById(batch.id), logger);

      // Releases the syncing claim (syncing -> connected).
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
      });
    } finally {
      await flushReclaimedStorage();

      // Recompute for every membership change this run made - the genuine deletes above and every
      // copy retired since. In the `finally` because a mid-loop throw is rethrown for SQS retry, and
      // the retry re-walks a folder whose removals and retires are ALREADY applied: it finds nothing
      // to do and skips the recompute too, leaving fileCount/totalSizeBytes overstated until some
      // unrelated write happens to fix them. Swallowed like the flush above, and because a throw
      // raised here would replace the original error on its way to SQS.
      //
      // The freshly-uploaded replacements are still 'pending' and excluded from the stats aggregate
      // until the pipeline vectorizes them and finalizeBatchIfComplete recomputes again, exactly as a
      // plain add already does.
      if (removed.length > 0 || retired > 0) {
        await recomputeStats().catch(e =>
          logger.error('[driveLakeIngest] failed to recompute lake stats', {
            connectionId,
            error: e instanceof Error ? e.message : String(e),
          })
        );
      }
    }
  } catch (err) {
    // Release the syncing claim so a retry can re-run - guarded so it can't clobber a
    // credential_error that getValidConnectionDriveAccessToken set underneath us. Carry the failure
    // onto `lastError`: the release heals the status back to 'connected' and stamps lastPolledAt, so
    // without this a deterministically-broken connection reads healthy and freshly-polled with no
    // operator-visible sign that every sync is dying.
    if (claimed && connectionId) {
      await orgGoogleDriveConnectionRepository
        .releaseSyncClaim(connectionId, err instanceof Error ? err.message : String(err))
        .catch(e =>
          logger.error(`[driveLakeIngest] failed to release sync claim: ${e instanceof Error ? e.message : String(e)}`)
        );
    }
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping drive-lake-ingest message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err; // DB / network / Drive - let SQS retry, then DLQ.
  }
});
