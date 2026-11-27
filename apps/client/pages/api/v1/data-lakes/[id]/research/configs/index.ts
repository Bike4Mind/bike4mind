/**
 * /api/v1/data-lakes/{id}/research/configs - a lake's saved research configurations.
 *
 *   GET  - list them (`listDataLakeResearchConfigsContract`)
 *   POST - save a new one (`createDataLakeResearchConfigContract`)
 *
 * Public twins of the SPA routes under /api/data-lakes/:id/research/configs, running the same
 * handler bodies (server/dataLakes/research). Member-scoped (`toMemberAccessContext`): a platform
 * admin who is not a manager of the lake does not reach its research through the public API.
 */
import { createDataLakeResearchConfigContract, listDataLakeResearchConfigsContract } from '@bike4mind/common';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import {
  CreateResearchConfigInput,
  createLakeResearchConfig,
  listLakeResearchConfigs,
} from '@server/dataLakes/research/researchConfigHandlers';
import {
  cursorScope,
  keysetWindow,
  researchRateLimit,
  sliceKeysetPage,
  toCamelInput,
} from '@server/dataLakes/research/v1Shared';
import { toPublicConfig } from '@server/dataLakes/toPublicResearch';

const BUCKET = '/api/v1/data-lakes/[id]/research/configs';

const listRouter = nextRouteForContract(listDataLakeResearchConfigsContract, { rateLimit: researchRateLimit(BUCKET) })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const lakeId = req.validatedParams.id;
    const scope = cursorScope('data-lake-research-configs', lakeId);
    const { limit } = req.validatedQuery;
    const { configs, pendingProposals } = await listLakeResearchConfigs(
      req,
      lakeId,
      await toMemberAccessContext(req),
      () => keysetWindow(scope, req.validatedQuery)
    );
    const page = sliceKeysetPage(configs, limit, scope);
    return res.json({ data: page.items.map(c => toPublicConfig(c, pendingProposals)), next_cursor: page.next_cursor });
  });

const createRouter = nextRouteForContract(createDataLakeResearchConfigContract, {
  rateLimit: researchRateLimit(BUCKET),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req, res) => {
    const ctx = await toMemberAccessContext(req);
    const config = await createLakeResearchConfig(req, req.validatedParams.id, ctx, () =>
      CreateResearchConfigInput.parse(toCamelInput(req.validated))
    );
    // A new config has had no scheduled outcome and the schedule cannot be held before its first tick.
    return res.status(201).json({ data: toPublicConfig(config, 0) });
  });

export default dispatchByMethod({ GET: listRouter, POST: createRouter });

export const config = {
  api: { externalResolver: true },
};
