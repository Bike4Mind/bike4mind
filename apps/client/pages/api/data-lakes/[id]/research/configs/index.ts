import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeResearchService } from '@bike4mind/services';
import { dataLakeResearchConfigRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { assertLakeResearchManage } from '@server/dataLakes/assertLakeResearchManage';
import { ResearchLeversInput } from '@server/dataLakes/researchConfigInput';

const CreateInput = ResearchLeversInput.extend({
  name: z.string(),
  // Accepted so a client can be explicit, then refused by the service for anything but `on_demand`.
  // Silently coercing it would save a config whose trigger field means nothing.
  trigger: z.enum(['on_demand', 'periodic', 'scheduled']).optional(),
});

const db = { dataLakeResearchConfigs: dataLakeResearchConfigRepository };

/**
 * GET  /api/data-lakes/:id/research/configs - the lake's saved research configurations (#1682).
 * POST /api/data-lakes/:id/research/configs - save a new one.
 *
 * Manage-gated on both verbs (see `assertLakeResearchManage`). Bounds and normalization live in the
 * service, not here, so a config written through any future second path means the same thing.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const lake = await assertLakeResearchManage(req, id);
    const configs = await dataLakeResearchService.listResearchConfigs(lake.id, { db });
    return res.json({ data: configs });
  })
  .post(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const lake = await assertLakeResearchManage(req, id);
    const input = CreateInput.parse(req.body);

    const config = await dataLakeResearchService.createResearchConfig(lake.id, req.user!.id, input, { db });
    return res.status(201).json({ data: config });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
