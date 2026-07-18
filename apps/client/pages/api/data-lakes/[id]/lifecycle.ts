import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeBatchRepository, fabFileRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';

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
    dataLakeService.assertLakeWritable(lake);
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
        // Phase-2 hard delete can fan out over every file/chunk in the lake, which blows the
        // request Lambda's timeout on a large lake. Offload to the background consumer instead.
        // Mirror the service's owner/admin + soft-deleted guards synchronously so a non-owner or
        // a not-deleted request gets an immediate 4xx rather than a 202 for a message the consumer
        // would just drop (the consumer re-checks the same guards, so a stale message is still safe).
        if (!actor.isAdmin && lake.createdByUserId !== actor.userId) {
          return res.status(403).json({ error: 'Only the creator can clean up this data lake' });
        }
        if (lake.status !== 'deleted') {
          return res.status(400).json({ error: 'Data lake must be soft-deleted before cleanup' });
        }
        await sendToQueue(getSourceQueueUrl('dataLakeCleanupQueue'), { dataLakeId: lake.id, actor });
        return res.status(202).json({ success: true, queued: true });
      }
    }
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
