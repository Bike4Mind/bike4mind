import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { ComputeSyncDeltaRequestInput } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

const HASH_QUERY_CHUNK = 500;

/**
 * POST /api/data-lakes/compute-sync-delta
 *
 * Compares client-side file manifest against existing files in a data lake
 * to determine which files need uploading, updating, or can be skipped - honoring
 * the per-request conflict-resolution policy (skip | update | duplicate).
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const data = ComputeSyncDeltaRequestInput.parse(req.body);
    const policy = data.conflictResolution ?? 'skip';

    // Shared access gate (resolves by slug; not-found-style denial).
    const dataLake = await dataLakeService.assertLakeAccess(data.dataLakeSlug, await toAccessContext(req), {
      db: { dataLakes: dataLakeRepository },
    });

    // Find existing files with matching hashes across all data lake files (cross-user
    // dedup for shared lakes). Chunk the $in to avoid a single oversized query.
    const datalakeTag = dataLake.datalakeTag;
    const clientHashes = data.currentFiles.map(f => f.contentHash);
    const existingHashMap = new Map<string, { fileId: string; fileName: string }>();
    for (let i = 0; i < clientHashes.length; i += HASH_QUERY_CHUNK) {
      const slice = clientHashes.slice(i, i + HASH_QUERY_CHUNK);
      const existingFiles = await fabFileRepository.findByContentHashesInDataLake(slice, datalakeTag);
      for (const f of existingFiles) {
        if (f.contentHash) existingHashMap.set(f.contentHash, { fileId: f.id, fileName: f.fileName });
      }
    }

    // Classify each file per the conflict policy:
    //  - skip:      known files are skipped (default)
    //  - update:    known files are re-uploaded against the existing record
    //  - duplicate: known files are uploaded as new copies
    const upload: typeof data.currentFiles = [];
    const skip: string[] = [];
    const update: { existingFileId: string; relativePath: string; fileName: string; contentHash: string }[] = [];

    for (const file of data.currentFiles) {
      const existing = existingHashMap.get(file.contentHash);
      if (!existing) {
        upload.push(file);
        continue;
      }
      if (policy === 'update') {
        update.push({
          existingFileId: existing.fileId,
          relativePath: file.relativePath,
          fileName: file.fileName,
          contentHash: file.contentHash,
        });
      } else if (policy === 'duplicate') {
        upload.push(file);
      } else {
        skip.push(file.relativePath);
      }
    }

    return res.json({
      dataLakeId: dataLake.id,
      delta: {
        upload: upload.map(f => ({
          relativePath: f.relativePath,
          fileName: f.fileName,
          contentHash: f.contentHash,
        })),
        update,
        skip,
        totalFiles: data.currentFiles.length,
        newFiles: upload.length,
        unchangedFiles: skip.length,
      },
    });
  });

export const config = {
  api: {
    externalResolver: true,
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
};

export default handler;
