import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  User,
  dataLakeRepository,
  dataLakeBatchRepository,
  fabFileRepository,
  orgGoogleDriveConnectionRepository,
} from '@bike4mind/database';
import { DATALAKE_TAG_STRENGTH, KnowledgeType, FabFileSourceType, type IUserDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
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

// Per-sync candidate cap. A folder whose new-file count can't be fetched+uploaded within the queue
// Lambda's hard 10-minute ceiling would time out mid-loop EVERY run - a deterministic (not transient)
// failure - and since the retry re-creates FabFiles for the un-uploaded tail (dedup excludes `pending`),
// the duplicates accumulate without the ingest ever converging. Refuse such a folder up front, BEFORE
// any batch or FabFile exists, so no partial state is ever created. Full support for very large folders
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
function hasDriveFileChanged(
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
 * ADD a new file, RE-INGEST an edited one (its stale copy leaves the lake first), and REMOVE from
 * the lake one that is gone from the folder. Adds/re-ingests fetch and upload ONE file at a time -
 * creating a lake-tagged FabFile and its batch-manifest entry BEFORE the bytes land - and let the
 * existing S3 objectCreated -> chunk -> vectorize -> finalize pipeline do the rest. Both the manual
 * Re-sync button and the scheduled poll cron (driveLakeResyncPoll) enqueue onto this one handler,
 * so there is a single delta-aware apply path.
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

    // 1) Walk the folder tree (one level per Drive call, recursed).
    const walked = await walkFolder(drive, connection.driveFolderId);

    // 2) Diff the walk against everything THIS connection has in the lake, keyed by the stable
    //    driveFileId, and split into ADD (new), UPDATE (same id, moved md5/modifiedTime), and
    //    REMOVE (in the lake, gone from the folder). The stored set is the connection's own files
    //    so a re-sync never touches files added by other means.
    const datalakeTag = lake.datalakeTag;
    const existingDocs = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, datalakeTag);
    const existingByDriveId = new Map<string, (typeof existingDocs)[number]>();
    for (const doc of existingDocs) {
      if (doc.driveFileId) existingByDriveId.set(doc.driveFileId, doc);
    }
    const walkedIds = new Set(walked.map(f => f.id));

    const pureAdds = walked.filter(f => !existingByDriveId.has(f.id));
    const changed = walked.filter(f => {
      const prior = existingByDriveId.get(f.id);
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

    // 3) Apply removals FIRST: the deletes, plus the stale copy of every edited file (re-added
    //    below with fresh content). Pull lake membership through the shared door, then recompute the
    //    lake's stats ONCE. A trusted system reconcile acts as admin (canManageLake) - the connection
    //    was authorized by an org owner/manager at connect time (verifyOrgAccess) - and this only
    //    UNPICKS lake membership: the FabFile stays in the owner's Files and its chunks are untouched.
    const staleCopies = changed
      .map(f => existingByDriveId.get(f.id))
      .filter((doc): doc is (typeof existingDocs)[number] => doc != null);
    const toRemove = [...removed, ...staleCopies];
    if (toRemove.length > 0) {
      const membershipActor = { userId: connection.connectedBy, isAdmin: true };
      const membershipLake = {
        id: lake.id,
        datalakeTag: lake.datalakeTag,
        fileTagPrefix: lake.fileTagPrefix,
        createdByUserId: lake.createdByUserId,
      };
      for (const doc of toRemove) {
        await dataLakeService.removeFileFromLake(membershipActor, membershipLake, doc.id, {
          db: { fabFiles: fabFileRepository },
        });
      }
      await dataLakeService.recomputeLakeStats(membershipLake, {
        db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
      });
    }

    // Adds and edited files both ingest fresh (an edited file's stale copy left the lake above).
    const candidates = [...pureAdds, ...changed];

    if (candidates.length === 0) {
      logger.info('[driveLakeIngest] reconciled; no files to ingest', {
        walked: walked.length,
        existing: existingDocs.length,
        removed: removed.length,
        updated: changed.length,
      });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
      });
      return;
    }

    // A folder too large to finish in one run would time out mid-loop every attempt and accumulate
    // duplicates (see MAX_INGEST_CANDIDATES). Refuse it here, before any batch/FabFile is created, and
    // record a guiding error - a deterministic condition, so return cleanly rather than DLQ-ing a retry.
    if (candidates.length > MAX_INGEST_CANDIDATES) {
      logger.warn('[driveLakeIngest] folder exceeds single-sync ingest cap; refusing', {
        connectionId,
        candidates: candidates.length,
        cap: MAX_INGEST_CANDIDATES,
      });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
        lastError: `Folder has ${candidates.length} new files, over the ${MAX_INGEST_CANDIDATES}-file limit for a single sync. Split it into subfolders and connect them separately.`,
      });
      return;
    }

    // 4) Create the batch. totalFiles is the candidate count; a per-file skip is folded into
    //    skippedFiles as it happens (see step 4), so the finalize gate is still reached exactly.
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

    // 5) One file at a time: size-gate -> fetch -> create FabFile -> append its manifest entry ->
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
  } catch (err) {
    // Release the syncing claim so a retry can re-run - guarded so it can't clobber a
    // credential_error that getValidConnectionDriveAccessToken set underneath us.
    if (claimed && connectionId) {
      await orgGoogleDriveConnectionRepository
        .releaseSyncClaim(connectionId)
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
