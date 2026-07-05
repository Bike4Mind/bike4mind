import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BatchPresignedUrlRequestInput, KnowledgeType, type IDataLakeBatchFile } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { createFabFile } from '@server/managers/fabFileManager';
import { adminSettingsRepository, dataLakeBatchRepository, dataLakeRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { checkStorageLimit, getSettingsMap, resolveSupportedMimeType } from '@bike4mind/utils';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { Resource } from 'sst';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

const s3Client = new S3Client();
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
  let datalakeTag: string | undefined;
  if (data.dataLakeSlug) {
    const dataLake = await dataLakeService.assertLakeWriteAccess(data.dataLakeSlug, await toAccessContext(req), {
      db: { dataLakes: dataLakeRepository },
    });
    datalakeTag = dataLake.datalakeTag;
  }

  // Defense-in-depth: a caller could also smuggle a `datalake:*` meta-tag for a DIFFERENT lake
  // through per-file tags. Gate every such tag with the same write check.
  const clientMetaTags = data.files.flatMap(f => (f.tags ?? []).map(t => t.name));
  await dataLakeService.assertCanWriteDataLakeTags({ userId, isAdmin: !!req.user.isAdmin }, clientMetaTags, {
    db: { dataLakes: dataLakeRepository },
  });

  // Verify batch ownership before stamping/appending - batchId comes from the body,
  // so without this a user could inject files into another user's batch (IDOR).
  if (data.batchId) {
    const batch = await dataLakeBatchRepository.findById(data.batchId);
    if (!batch || batch.userId !== userId) {
      throw new NotFoundError('Batch not found');
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

  const results = await Promise.all(
    resolvedFiles.map(async ({ item: fileItem, mimeType }) => {
      const ext = mime.extension(mimeType);
      const fileKey = `${uuidv4()}${ext ? `.${ext}` : ''}`;

      // Merge data lake meta-tag with file-specific tags
      const tags = [...(fileItem.tags || [])];
      if (datalakeTag) {
        tags.push({ name: datalakeTag, strength: 1.0 });
      }

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

      const url = await getSignedUrl(s3Client, command, { expiresIn: EXPIRES });

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
