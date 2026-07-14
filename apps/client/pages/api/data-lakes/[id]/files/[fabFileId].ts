import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/**
 * DELETE /api/data-lakes/:id/files/:fabFileId
 * Removes a single file from a data lake (lake-scoped: drops the lake's datalake tag +
 * stat recompute; the file and its chunks survive - see removeFileFromDataLake).
 * Access-gated like the articles list (org-aware, not-found-style denial); the write is
 * then further restricted to owner/admin inside the service.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .delete(async (req: Request<{}, unknown, unknown, { id: string; fabFileId: string }>, res) => {
    const { id, fabFileId } = req.query;
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });
    dataLakeService.assertLakeWritable(lake);

    const result = await dataLakeService.removeFileFromDataLake(
      { userId: ctx.userId, isAdmin: ctx.isAdmin },
      lake.id,
      fabFileId,
      {
        db: {
          dataLakes: dataLakeRepository,
          fabFiles: fabFileRepository,
        },
      }
    );

    return res.json(result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
