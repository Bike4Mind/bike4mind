/**
 * GET /api/v1/data-lakes/{id}/research/runs/{run_id} - one research run (`getDataLakeResearchRunContract`).
 *
 * The poll target of POST .../research/runs. The SPA has no single-run read, so this applies the
 * same manage gate as its siblings and then looks the run up inside that lake: a run of another lake
 * is a 404.
 */
import { getDataLakeResearchRunContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { getLakeResearchRun } from '@server/dataLakes/research/researchRunHandlers';
import { researchRateLimit } from '@server/dataLakes/research/v1Shared';
import { toPublicRun } from '@server/dataLakes/toPublicResearch';

const handler = nextRouteForContract(getDataLakeResearchRunContract, {
  rateLimit: researchRateLimit('/api/v1/data-lakes/[id]/research/runs/[run_id]'),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const { id, run_id } = req.validatedParams;
    const run = await getLakeResearchRun(req, id, run_id, await toMemberAccessContext(req));
    return res.json({ data: toPublicRun(run) });
  });

export default handler;

export const config = {
  api: { externalResolver: true },
};
