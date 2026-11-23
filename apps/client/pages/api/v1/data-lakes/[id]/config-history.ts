/**
 * GET /api/v1/data-lakes/{id}/config-history - who changed how the lake answers (`getDataLakeConfigHistoryContract`).
 *
 * Public twin of GET /api/data-lakes/:id/config-history on the same handler body. Manage-gated, and
 * the view is mapped so user ids become display names before anything leaves the server.
 */
import { getDataLakeConfigHistoryContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { readLakeConfigHistory } from '@server/dataLakes/research/configHistoryHandler';
import { researchRateLimit } from '@server/dataLakes/research/v1Shared';
import { toPublicConfigHistory } from '@server/dataLakes/toPublicResearch';

const handler = nextRouteForContract(getDataLakeConfigHistoryContract, {
  rateLimit: researchRateLimit('/api/v1/data-lakes/[id]/config-history'),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const view = await readLakeConfigHistory(
      req.validatedParams.id,
      await toMemberAccessContext(req),
      req.validatedQuery.limit,
      req.validatedQuery.include === 'files'
    );
    return res.json(toPublicConfigHistory(view));
  });

export default handler;

export const config = {
  api: { externalResolver: true },
};
