import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeBatchRepository,
  fabFileRepository,
  fabFileChunkRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

const LifecycleInput = z.object({
  action: z.enum(['archive', 'unarchive', 'restore', 'delete', 'cleanup']),
});

/**
 * POST /api/data-lakes/:id/lifecycle  { action }
 * Drives the lake lifecycle through the service layer so the required side effects
 * (cancel in-flight batch, archive/soft-delete files, dedup on restore, stat
 * recompute, best-effort index removal) always run. Writes are owner/admin only.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { action } = LifecycleInput.parse(req.body);
    const ctx = await toAccessContext(req);

    // Resolve + access-gate the lake first (not-found-style denial). Writes are then
    // further restricted to owner/admin inside each service.
    const lake = await dataLakeService.assertLakeAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });
    const actor = { userId: ctx.userId, isAdmin: ctx.isAdmin };

    switch (action) {
      case 'archive': {
        const result = await dataLakeService.archiveDataLake(actor, lake.id, {
          db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository, fabFiles: fabFileRepository },
        });
        return res.json(result);
      }
      case 'unarchive': {
        const result = await dataLakeService.unarchiveDataLake(actor, lake.id, {
          db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
        });
        return res.json(result);
      }
      case 'restore': {
        // Recover a soft-deleted (phase-1) lake back to active.
        const result = await dataLakeService.restoreDeletedDataLake(actor, lake.id, {
          db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
        });
        return res.json(result);
      }
      case 'delete': {
        const result = await dataLakeService.deleteDataLake(actor, lake.id, {
          db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository, fabFiles: fabFileRepository },
        });
        return res.json(result);
      }
      case 'cleanup': {
        await dataLakeService.cleanupDeletedDataLake(actor, lake.id, {
          db: {
            dataLakes: dataLakeRepository,
            batches: dataLakeBatchRepository,
            fabFiles: fabFileRepository,
            fabFileChunks: fabFileChunkRepository,
          },
        });
        return res.json({ success: true });
      }
    }
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
