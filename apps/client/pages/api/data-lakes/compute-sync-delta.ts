import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import {
  adminSettingsRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileRepository,
  lakeAccessEventRepository,
} from '@bike4mind/database';
import { ComputeSyncDeltaRequestInput } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { normalizeId } from '@bike4mind/utils/normalizeId';

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
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
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

    // Best-effort audit write - a hash match reveals a file's existence (id + name)
    // regardless of which policy branch then classifies it, so every matched hash counts here,
    // not only the skip/update arms. Skipped entirely when nothing matched: a manifest full of
    // new files touches no existing lake content, so there is nothing to attribute a read to.
    // Awaited (never rethrows): a per-request serverless route must not race a post-response
    // environment freeze.
    if (existingHashMap.size > 0) {
      await dataLakeService.recordLakeAccessEvent(
        lakeAccessEventRepository,
        {
          principalKind: 'user',
          principalId: req.user.id,
          organizationId: normalizeId(req.user.organizationId),
          resolvedLakeIds: [dataLake.id],
          fileIds: [...existingHashMap.values()].map(f => f.fileId),
          surface: 'data-lake-sync-delta',
        },
        req.logger,
        adminSettingsRepository
      );
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
