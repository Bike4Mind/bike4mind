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
  type IDataLakeBatchFile,
  type IUserDocument,
} from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { createFabFile } from '@server/managers/fabFileManager';
import defineAbilitiesFor from '@server/auth/ability';
import { getFilesStorage } from '@server/utils/storage';
import { getValidConnectionDriveAccessToken } from '@server/integrations/google/drive/common';
import { createDriveClient } from '@server/integrations/google/drive/driveClient';
import { walkFolder, fetchDriveFileContent } from '@server/integrations/google/drive/driveContent';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { z, ZodError } from 'zod';

const Payload = z.object({ connectionId: z.string() });

/**
 * Background ingest of an org Google Drive folder into a data lake (#1589). Walks the folder,
 * fetches/exports each file, creates lake-tagged FabFiles, and lands their bytes in the FabFile
 * bucket - the existing S3 objectCreated -> chunk -> vectorize -> finalize pipeline does the rest.
 * Idempotent: files already ingested (by driveFileId) are skipped, so a redelivery/re-run is safe.
 *
 * v1 loads each file's bytes in turn and holds the ingestable set in memory before creating the
 * batch (so totalFiles is exact). A very large folder should slice/continue like
 * lakeMemoryExtraction - deferred follow-up.
 */
export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  try {
    const { connectionId } = Payload.parse(JSON.parse(event.Records[0].body));
    logger.updateMetadata({ handler: 'driveLakeIngest', connectionId });

    const connection = await orgGoogleDriveConnectionRepository.findById(connectionId);
    if (!connection) {
      logger.warn('[driveLakeIngest] connection not found; dropping', { connectionId });
      return;
    }
    const lake = await dataLakeRepository.findById(connection.targetDataLakeId);
    if (!lake) {
      logger.warn('[driveLakeIngest] target data lake not found; dropping', { connectionId });
      return;
    }
    const user = await User.findById(connection.connectedBy);
    if (!user) {
      logger.warn('[driveLakeIngest] connecting user not found; dropping', { connectionId });
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

    // 3) Fetch bytes; keep only what we can actually ingest. A skipped file (oversized export,
    //    unsupported type, transient error) is NOT counted - totalFiles must equal the set that
    //    actually uploads, or the batch never reaches its finalize threshold and hangs.
    const fetched: Array<{ file: (typeof candidates)[number]; bytes: Buffer; mimeType: string }> = [];
    let skipped = 0;
    for (const file of candidates) {
      const result = await fetchDriveFileContent(drive, file);
      if (result.ok) {
        fetched.push({ file, bytes: result.bytes, mimeType: result.mimeType });
      } else {
        skipped++;
        logger.info('[driveLakeIngest] skipping file', { driveFileId: file.id, reason: result.reason });
      }
    }

    logger.info('[driveLakeIngest] walk complete', {
      walked: walked.length,
      alreadyIngested: alreadyIngested.size,
      toIngest: fetched.length,
      skipped,
    });

    if (fetched.length === 0) {
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
      });
      return;
    }

    // 4) Create the batch with an ACCURATE totalFiles (only files that will upload).
    const totalSizeBytes = fetched.reduce((sum, f) => sum + f.bytes.length, 0);
    const batch = await dataLakeBatchRepository.create({
      dataLakeId: connection.targetDataLakeId,
      userId: connection.connectedBy,
      status: 'processing',
      conflictResolution: 'skip',
      totalFiles: fetched.length,
      totalSizeBytes,
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

    // 5) Per file: create the FabFile row BEFORE uploading its bytes (objectCreated maps the S3
    //    object back to the row by filePath and skips if the row isn't there yet), then upload -
    //    which fires objectCreated -> chunk -> vectorize. The batch manifest lets claimFileStatus
    //    advance progress to completion.
    const applyFallbackTags = dataLakeService.createDataLakeFallbackTagger({
      db: { dataLakes: dataLakeRepository },
      logger,
    });
    const storage = getFilesStorage();
    const manifest: IDataLakeBatchFile[] = [];

    for (const { file, bytes, mimeType } of fetched) {
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

      await storage.upload(bytes, fileKey, { ContentType: mimeType });

      manifest.push({
        fabFileId: fabFile.id,
        fileName: file.name,
        relativePath: file.relativePath,
        status: 'pending',
      });
    }

    await dataLakeBatchRepository.appendFiles(batch.id, manifest);
    await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
      status: 'connected',
      lastPolledAt: new Date(),
    });

    logger.info('[driveLakeIngest] uploaded; pipeline will chunk+vectorize', {
      connectionId,
      batchId: batch.id,
      files: manifest.length,
      skipped,
    });
  } catch (err) {
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping drive-lake-ingest message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err; // DB / network / Drive - let SQS retry, then DLQ.
  }
});
