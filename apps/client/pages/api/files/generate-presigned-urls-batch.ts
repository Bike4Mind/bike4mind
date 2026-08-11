import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Client } from '@bike4mind/fab-pipeline';
import {
  BatchPresignedUrlRequestInput,
  DATALAKE_TAG_PREFIX,
  DATALAKE_TAG_STRENGTH,
  KnowledgeType,
  type IDataLakeBatchFile,
  type IDataLakeDocument,
} from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { createFabFile } from '@server/managers/fabFileManager';
import { adminSettingsRepository, dataLakeBatchRepository, dataLakeRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { checkStorageLimit, getSettingsMap, resolveSupportedMimeType } from '@bike4mind/utils';
import { BadRequestError } from '@server/utils/errors';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { Resource } from 'sst';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { resolveBrowserUploadUrl } from '@server/utils/browserUploadUrl';

const s3Client = createS3Client();
const EXPIRES = 600; // 10 minutes

const handler = baseApi().post(async (req: Request, res) => {
  const userId = req.user.id;
  const data = BatchPresignedUrlRequestInput.parse(req.body);

  // When this upload is bound to a data lake, enforce the same feature gate as the
  // dedicated data-lake endpoints (this is the data-lake upload entry door).
  if (data.dataLakeSlug || data.batchId) {
    const enabled = await adminSettingsRepository.getSettingsValue('EnableDataLakes');
    if (!enabled) {
      return res.status(403).json({ error: 'Feature not available', code: 'FEATURE_DISABLED' });
    }
  }

  // Look up data lake for meta-tag injection. Uploading into a lake is a WRITE, so enforce the
  // creator/admin gate (not just read access) - otherwise a read-only member could inject files.
  // Not-found-style denial when unreadable; manage-denied when readable but not owned.
  let dataLake: IDataLakeDocument | undefined;
  if (data.dataLakeSlug) {
    dataLake = await dataLakeService.assertLakeWriteAccess(data.dataLakeSlug, await toAccessContext(req), {
      db: { dataLakes: dataLakeRepository },
    });
    // Same rule as the batch-create door: only a draft (first batch) or active lake takes new
    // files, so an archived/deleting one cannot be topped up through this entrance either.
    if (dataLake.status !== 'draft' && dataLake.status !== 'active') {
      return res.status(400).json({ error: `Cannot upload into a data lake in '${dataLake.status}' status` });
    }
  }
  const datalakeTag = dataLake?.datalakeTag;

  // Defense-in-depth: a caller could also smuggle a `datalake:*` meta-tag for a DIFFERENT lake
  // through per-file tags. Gate every such tag with the same write check.
  const clientMetaTags = data.files.flatMap(f => (f.tags ?? []).map(t => t.name));
  await dataLakeService.assertCanWriteDataLakeTags({ userId, isAdmin: !!req.user.isAdmin }, clientMetaTags, {
    db: { dataLakes: dataLakeRepository },
  });
  // This route creates each FabFile through the manager's direct FabFile.create(), not the
  // fabFileService.createFabFile door that gates the static-registry namespace centrally - so
  // it needs its own check, same as the meta-tag one above.
  dataLakeService.assertCanWriteStaticRegistryTags({ userId, isAdmin: !!req.user.isAdmin }, clientMetaTags);

  // A meta-tag the client sent must name the lake this upload is joining, not merely some lake
  // the caller may write to - which, for an admin, is all of them.
  if (dataLake) {
    try {
      dataLakeService.assertMetaTagsMatchLake(dataLake, clientMetaTags);
    } catch (err) {
      // Worth a log line: a spike here separates a stale client from a real regression, and the
      // refusal message alone cannot tell an operator which lake was asked for. The tags are
      // unconstrained user input, so JSON-encode them - a newline in a tag name would otherwise
      // forge a log line of its own.
      req.logger?.warn(
        `[dataLakes] refused an upload tagged for another lake: resolved=${dataLake.id} tags=${JSON.stringify(clientMetaTags)}`
      );
      throw err;
    }
  }

  // Verify batch ownership before stamping/appending - batchId comes from the body, so without
  // this a caller could inject files into another user's batch (IDOR). Shared with the
  // single-file presign and createFabFile routes so a future caller can't forget this check.
  // It hands back the batch it already read, which the lake-identity check below needs.
  if (data.batchId) {
    const batch = await dataLakeService.assertBatchOwnership(userId, data.batchId, {
      db: { batches: dataLakeBatchRepository },
    });
    try {
      dataLakeService.assertBatchBelongsToLake(batch, dataLake);
    } catch (err) {
      // Logged for the same reason as the meta-tag refusal above: post-deploy, a stale client
      // still sending a name-derived slug and a real regression are indistinguishable from the
      // message alone.
      // Same encoding as the meta-tag line above, for the same reason - these ids are generated
      // rather than user-supplied, but a log line should not depend on that staying true.
      req.logger?.warn(
        `[dataLakes] refused an upload whose batch names another lake: ${JSON.stringify({
          batch: batch.id,
          batchLake: batch.dataLakeId,
          resolved: dataLake?.id ?? null,
        })}`
      );
      throw err;
    }
  }

  // Check individual file sizes against max file size setting
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  let maxFileSize: number = 20 * 1024 * 1024; // Default to 20MB
  if (settings.MaxFileSize) {
    try {
      maxFileSize = parseInt(settings.MaxFileSize, 10) * 1024 * 1024;
    } catch {
      // Fall back to default
    }
  }

  // Validate every file up front (size + supported type) BEFORE any FabFile is
  // created below, so a single unsupported file can't leave partial lake state.
  // Resolve each type once here and reuse it when stamping the FabFile.
  const resolvedFiles = data.files.map(fileItem => ({
    item: fileItem,
    ...resolveSupportedMimeType(fileItem.fileName, fileItem.mimeType),
  }));

  for (const { item: fileItem, supported } of resolvedFiles) {
    if (!fileItem.fileSize) throw new BadRequestError('No file size provided');
    if (fileItem.fileSize >= maxFileSize)
      throw new BadRequestError(`File "${fileItem.fileName}" exceeds maximum file size`);
    // Reject unsupported/binary types (e.g. .exe) at the ingest door - the
    // chunker can't vectorize them, so accepting them yields corrupt lake
    // state (a FabFile with 0 chunks).
    if (!supported)
      throw new BadRequestError(
        `File "${fileItem.fileName}" has an unsupported file type${
          fileItem.mimeType ? ` (${fileItem.mimeType})` : ''
        }. Supported types include documents, spreadsheets, images, code, and text files.`
      );
  }

  // Check total batch size against user storage limit (throws BadRequestError if exceeded)
  const totalBatchSize = data.files.reduce((sum, f) => sum + (f.fileSize || 0), 0);
  await checkStorageLimit(req.user, totalBatchSize);

  // One tagger for the whole request: it memoizes the lake lookup per meta-tag, so a batch of
  // hundreds of files into one lake costs a single read.
  const applyFallbackTags = dataLakeService.createDataLakeFallbackTagger({
    db: { dataLakes: dataLakeRepository },
    logger: req.logger,
  });

  // Resolve the lake BEFORE the per-file loop. The loop below runs under Promise.all, so a
  // rejection there lands after some files have already been created, and those FabFiles are
  // invisible to the client's rollback because it never received their ids. Doing the one
  // lake-dependent read up front means a lookup failure aborts with nothing persisted; the
  // memo makes this free for the files that follow.
  if (datalakeTag) {
    await applyFallbackTags([{ name: datalakeTag, strength: DATALAKE_TAG_STRENGTH }]);
  }

  const results = await Promise.all(
    resolvedFiles.map(async ({ item: fileItem, mimeType }) => {
      const ext = mime.extension(mimeType);
      const fileKey = `${uuidv4()}${ext ? `.${ext}` : ''}`;

      // Merge data lake meta-tag with file-specific tags, then guarantee the file also lands
      // under the lake's content prefix. Reconciling AFTER the injection is load-bearing: the
      // meta-tag is resolved server-side from `dataLakeSlug` and never appears in the client
      // payload, so a reconcile over `fileItem.tags` alone would see no lake at all.
      //
      // This is the flat-upload path. The wizard derives content tags from folder structure, so
      // a file picked through "Upload Files..." (relativePath with no separator) contributes
      // none, and append mode has no taxonomy step to supply them either.
      // Deduped by name: a client may smuggle the same meta-tag the server injects, and there is
      // no reason to persist it twice. The server's copy is spread FIRST and first occurrence
      // wins, so a client-supplied strength on the meta-tag cannot override it.
      //
      // Folded for the meta namespace only, because that is the one namespace whose consumers
      // fold: the write gate and the reconciler both lowercase, so `DataLake:acme` and
      // `datalake:acme` are one tag to them, and persisting both leaves a case-variant ghost that
      // removal (an exact-match pull) would not clear. Content tags stay case-sensitive - the
      // read arms and counters build unflagged regexes, so `Acme:x` and `acme:x` really are two.
      const dedupeKey = (name: string) =>
        name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX) ? name.toLowerCase() : name;
      const merged = [
        ...(datalakeTag ? [{ name: datalakeTag, strength: DATALAKE_TAG_STRENGTH }] : []),
        ...(fileItem.tags || []),
      ].filter((tag, i, all) => all.findIndex(other => dedupeKey(other.name) === dedupeKey(tag.name)) === i);
      const tags = await applyFallbackTags(merged);

      // Stamp batchId so the existing pipeline (objectCreated -> chunk -> vectorize)
      // correlates the file to its batch and updates batch progress. Without this the
      // batch never receives counter increments and hangs.
      const file = await createFabFile(
        {
          userId,
          filePath: fileKey,
          fileSize: fileItem.fileSize,
          fileName: fileItem.fileName,
          // Store the resolved supported type (not the raw claimed type) so the
          // chunker keys on a type it can vectorize - browsers often report ''
          // or application/octet-stream for supported code/text files.
          mimeType,
          type: KnowledgeType.FILE,
          tags,
          ...(fileItem.contentHash && { contentHash: fileItem.contentHash }),
          ...(fileItem.relativePath && { relativePath: fileItem.relativePath }),
          ...(data.batchId && { batchId: data.batchId }),
        },
        req.ability!
      );

      const command = new PutObjectCommand({
        Bucket: Resource.fabFileBucket.name,
        Key: fileKey,
      });

      // Hosted returns the direct S3 presign; self-host returns a same-origin proxy URL
      // (S3/MinIO isn't browser-reachable). Shared with the single-file path (createFabFile)
      // so the two upload entry points can't diverge.
      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: EXPIRES });
      const url = resolveBrowserUploadUrl(file.id, presignedUrl);

      return {
        fileId: file.id,
        fileKey,
        url,
        fileName: fileItem.fileName,
        manifestEntry: {
          fabFileId: file.id,
          fileName: fileItem.fileName,
          relativePath: fileItem.relativePath,
          contentHash: fileItem.contentHash,
          status: 'pending' as const,
        } satisfies IDataLakeBatchFile,
      };
    })
  );

  // Populate the batch manifest so per-file status updates (claim/updateFileStatus)
  // have entries to target. Atomic $push; safe across the chunked URL requests.
  if (data.batchId) {
    await dataLakeBatchRepository.appendFiles(
      data.batchId,
      results.map(r => r.manifestEntry)
    );
  }

  return res.json({ files: results.map(({ manifestEntry, ...rest }) => rest) });
});

export const config = {
  api: {
    externalResolver: true,
    bodyParser: {
      sizeLimit: '5mb', // Larger body for batch requests
    },
  },
};

export default handler;
