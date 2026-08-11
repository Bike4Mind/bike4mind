import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  User,
  dataLakeRepository,
  dataLakeBatchRepository,
  fabFileRepository,
  orgGoogleDriveConnectionRepository,
} from '@bike4mind/database';
import {
  DATALAKE_TAG_STRENGTH,
  KnowledgeType,
  FabFileSourceType,
  type IUserDocument,
} from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { createFabFile } from '@server/managers/fabFileManager';
import defineAbilitiesFor from '@server/auth/ability';
import { getFilesStorage } from '@server/utils/storage';
import { getValidConnectionDriveAccessToken } from '@server/integrations/google/drive/common';
import { createDriveClient } from '@server/integrations/google/drive/driveClient';
import { walkFolder, fetchDriveFileContent } from '@server/integrations/google/drive/driveContent';
import { finalizeBatchIfComplete } from '@server/queueHandlers/dataLakeBatchProgress';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { z, ZodError } from 'zod';

const Payload = z.object({ connectionId: z.string() });

// Per-file hard cap. Files are fetched and uploaded ONE at a time (only one buffer is ever live),
// so this bounds peak memory well under the ingest queue Lambda's 1024 MB default. An oversized
// file is skipped-and-counted (before the download when the size is known up front), so the failure
// mode is a skipped file rather than an OOM that kills the whole run mid-loop. A streaming path for
// genuinely large files is the "very large folders" follow-up.
const MAX_INGEST_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Background ingest of an org Google Drive folder into a data lake (#1589). Walks the folder, then
 * fetches and uploads ONE file at a time - creating a lake-tagged FabFile and its batch-manifest
 * entry BEFORE the bytes land - and lets the existing S3 objectCreated -> chunk -> vectorize ->
 * finalize pipeline do the rest. Idempotent across re-runs: files already ingested (by driveFileId)
 * are skipped, so a redelivery is safe.
 *
 * Ordering is load-bearing. `storage.upload` fires `objectCreated` synchronously, which walks
 * objectCreated -> chunk -> vectorize; each stage advances batch progress by claiming its manifest
 * file (claimFileStatus). If the manifest entry does not exist yet those claims silently no-op, so
 * vectorizedFiles never increments and the batch never crosses its finalize threshold. Hence the
 * per-file `appendFiles` AHEAD of `storage.upload`, not a single append after the loop.
 *
 * totalFiles is seeded with the candidate count; a skip (oversized / unsupported / transient fetch
 * error) is folded into `skippedFiles` as it happens, so `vectorized + failed + skipped` still
 * reaches totalFiles exactly (finalizeBatchIfComplete's gate) without the ingestable count being
 * known up front.
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
    ({ connectionId } = Payload.parse(JSON.parse(event.Records[0].body)));
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
      logger.info('[driveLakeIngest] connection already syncing; skipping duplicate run', { connectionId });
      return;
    }

    const lake = await dataLakeRepository.findById(connection.targetDataLakeId);
    if (!lake) {
      logger.warn('[driveLakeIngest] target data lake not found; dropping', { connectionId });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, { status: 'connected', lastPolledAt: new Date() });
      return;
    }
    const user = await User.findById(connection.connectedBy);
    if (!user) {
      logger.warn('[driveLakeIngest] connecting user not found; dropping', { connectionId });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, { status: 'connected', lastPolledAt: new Date() });
      return;
    }
    const ability = defineAbilitiesFor(user as unknown as IUserDocument);

    // Prefer the connection's own token; falls back to the connecting user's (D not built yet).
    // A credential failure marks the connection credential_error and throws so SQS retries -> DLQ.
    const accessToken = await getValidConnectionDriveAccessToken(connectionId, connection.organizationId);
    const drive = createDriveClient(accessToken);

    // 1) Walk the folder tree (one level per Drive call, recursed).
    const walked = await walkFolder(drive, connection.driveFolderId);

    // 2) Dedup by the stable driveFileId - skip files already ingested into this lake (idempotent
    //    re-runs). Re-ingesting an EDITED file is re-sync's job (issue E), not this full ingest.
    const datalakeTag = lake.datalakeTag;
    const existing = await fabFileRepository.findByDriveFileIdsInDataLake(
      walked.map(f => f.id),
      datalakeTag
    );
    const alreadyIngested = new Set(existing.map(f => f.driveFileId));
    const candidates = walked.filter(f => !alreadyIngested.has(f.id));

    if (candidates.length === 0) {
      logger.info('[driveLakeIngest] nothing new to ingest', {
        walked: walked.length,
        alreadyIngested: alreadyIngested.size,
      });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, { status: 'connected', lastPolledAt: new Date() });
      return;
    }

    // 3) Create the batch. totalFiles is the candidate count; a per-file skip is folded into
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

    // 4) One file at a time: size-gate -> fetch -> create FabFile -> append its manifest entry ->
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
      alreadyIngested: alreadyIngested.size,
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
        .catch(e => logger.error(`[driveLakeIngest] failed to release sync claim: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping drive-lake-ingest message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err; // DB / network / Drive - let SQS retry, then DLQ.
  }
});
