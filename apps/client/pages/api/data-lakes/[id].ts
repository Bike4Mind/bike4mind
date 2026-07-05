import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeBatchRepository, fabFileRepository } from '@bike4mind/database';
import { UpdateDataLakeRequestInput } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET /api/data-lakes/:id - get a single data lake (by ObjectId or slug)
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    // Single shared gate: resolves the lake and asserts owner/org/tag access,
    // denying with a not-found-style error so existence isn't disclosed.
    const dataLake = await dataLakeService.assertLakeAccess(id, await toAccessContext(req), {
      db: { dataLakes: dataLakeRepository },
    });
    return res.json(dataLake);
  })
  // PUT /api/data-lakes/:id - update a data lake (metadata only; not lifecycle)
  .put(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const params = UpdateDataLakeRequestInput.parse(req.body);
    const ctx = await toAccessContext(req);
    // Gate first (org-aware, not-found-style denial) so this write path can't be used
    // to probe existence or act cross-org - consistent with the lifecycle endpoint.
    const lake = await dataLakeService.assertLakeAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });

    const updated = await dataLakeService.updateDataLake(
      { userId: ctx.userId, isAdmin: ctx.isAdmin },
      lake.id,
      params,
      {
        db: { dataLakes: dataLakeRepository },
      }
    );

    return res.json(updated);
  })
  // DELETE /api/data-lakes/:id - archive a data lake (reversible; full teardown)
  .delete(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });

    const archived = await dataLakeService.archiveDataLake({ userId: ctx.userId, isAdmin: ctx.isAdmin }, lake.id, {
      db: {
        dataLakes: dataLakeRepository,
        batches: dataLakeBatchRepository,
        fabFiles: fabFileRepository,
      },
    });

    return res.json(archived);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
