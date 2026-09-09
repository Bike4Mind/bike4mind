import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeResearchService } from '@bike4mind/services';
import { dataLakeResearchConfigRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { assertLakeResearchManage } from '@server/dataLakes/assertLakeResearchManage';
import { ResearchLeversInput } from '@server/dataLakes/researchConfigInput';

const UpdateInput = ResearchLeversInput.extend({ name: z.string().optional() });

const db = { dataLakeResearchConfigs: dataLakeResearchConfigRepository };

/**
 * PUT    /api/data-lakes/:id/research/configs/:configId - edit a saved configuration (#1682).
 * DELETE /api/data-lakes/:id/research/configs/:configId - remove it.
 *
 * The lake from the path is resolved and manage-gated, then passed to the service, which scopes
 * every read and write to it. That pairing is what stops a caller who manages lake A from reaching
 * lake B's config by id - the repository filters on `dataLakeId`, not just on `_id`.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .put(async (req: Request, res) => {
    const { id, configId } = req.query as { id: string; configId: string };
    const lake = await assertLakeResearchManage(req, id);
    const input = UpdateInput.parse(req.body);

    const updated = await dataLakeResearchService.updateResearchConfig(configId, lake.id, req.user!.id, input, { db });
    return res.json({ data: updated });
  })
  .delete(async (req: Request, res) => {
    const { id, configId } = req.query as { id: string; configId: string };
    const lake = await assertLakeResearchManage(req, id);

    await dataLakeResearchService.deleteResearchConfig(configId, lake.id, { db });
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
