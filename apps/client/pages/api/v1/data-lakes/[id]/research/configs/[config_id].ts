/**
 * /api/v1/data-lakes/{id}/research/configs/{config_id} - one saved research configuration.
 *
 *   GET    - read it (`getDataLakeResearchConfigContract`)
 *   PATCH  - edit it, or pause and resume its schedule (`updateDataLakeResearchConfigContract`)
 *   DELETE - remove it (`deleteDataLakeResearchConfigContract`)
 *
 * Public twins of PUT/DELETE /api/data-lakes/:id/research/configs/:configId (the SPA has no single
 * read), on the same handler bodies. A config of another lake is a 404, never a read.
 */
import {
  deleteDataLakeResearchConfigContract,
  getDataLakeResearchConfigContract,
  updateDataLakeResearchConfigContract,
} from '@bike4mind/common';
import { dataLakeProposalRepository } from '@bike4mind/database';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import {
  UpdateResearchConfigInput,
  deleteLakeResearchConfig,
  getLakeResearchConfig,
  updateLakeResearchConfig,
} from '@server/dataLakes/research/researchConfigHandlers';
import { researchRateLimit, toCamelInput } from '@server/dataLakes/research/v1Shared';
import { toPublicConfig } from '@server/dataLakes/toPublicResearch';

const BUCKET = '/api/v1/data-lakes/[id]/research/configs/[config_id]';

/** The lake's live pending count, which `held` is computed from. */
async function pendingCount(lakeId: string): Promise<number> {
  const byLake = await dataLakeProposalRepository.countPendingByLakes([lakeId]);
  return byLake[lakeId] ?? 0;
}

const getRouter = nextRouteForContract(getDataLakeResearchConfigContract, { rateLimit: researchRateLimit(BUCKET) })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const { id, config_id } = req.validatedParams;
    const config = await getLakeResearchConfig(req, id, config_id, await toMemberAccessContext(req));
    return res.json({ data: toPublicConfig(config, await pendingCount(config.dataLakeId)) });
  });

const updateRouter = nextRouteForContract(updateDataLakeResearchConfigContract, {
  rateLimit: researchRateLimit(BUCKET),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .patch(async (req, res) => {
    const { id, config_id } = req.validatedParams;
    const ctx = await toMemberAccessContext(req);
    const config = await updateLakeResearchConfig(req, id, config_id, ctx, () =>
      UpdateResearchConfigInput.parse(toCamelInput(req.validated))
    );
    return res.json({ data: toPublicConfig(config, await pendingCount(config.dataLakeId)) });
  });

const deleteRouter = nextRouteForContract(deleteDataLakeResearchConfigContract, {
  rateLimit: researchRateLimit(BUCKET),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .delete(async (req, res) => {
    const { id, config_id } = req.validatedParams;
    await deleteLakeResearchConfig(req, id, config_id, await toMemberAccessContext(req));
    return res.status(204).end();
  });

export default dispatchByMethod({ GET: getRouter, PATCH: updateRouter, DELETE: deleteRouter });

export const config = {
  api: { externalResolver: true },
};
