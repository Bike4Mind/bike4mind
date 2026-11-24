/**
 * /api/v1/data-lakes/{id}/research/runs - a lake's research runs.
 *
 *   GET  - the run history (`listDataLakeResearchRunsContract`)
 *   POST - start a run from a saved config (`startDataLakeResearchRunContract`)
 *
 * Public twins of the SPA routes under /api/data-lakes/:id/research/runs, on the same handler
 * bodies: the POST writes the run row, then enqueues it, and counts against the completion quota
 * of an untrusted key.
 */
import { listDataLakeResearchRunsContract, startDataLakeResearchRunContract } from '@bike4mind/common';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { listLakeResearchRuns, startLakeResearchRun } from '@server/dataLakes/research/researchRunHandlers';
import { cursorScope, keysetWindow, researchRateLimit, sliceKeysetPage } from '@server/dataLakes/research/v1Shared';
import { toPublicRun } from '@server/dataLakes/toPublicResearch';

const BUCKET = '/api/v1/data-lakes/[id]/research/runs';

const listRouter = nextRouteForContract(listDataLakeResearchRunsContract, { rateLimit: researchRateLimit(BUCKET) })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const lakeId = req.validatedParams.id;
    const scope = cursorScope('data-lake-research-runs', lakeId);
    const { limit } = req.validatedQuery;
    const runs = await listLakeResearchRuns(req, lakeId, await toMemberAccessContext(req), () =>
      keysetWindow(scope, req.validatedQuery)
    );
    const page = sliceKeysetPage(runs, limit, scope);
    return res.json({ data: page.items.map(toPublicRun), next_cursor: page.next_cursor });
  });

const startRouter = nextRouteForContract(startDataLakeResearchRunContract, { rateLimit: researchRateLimit(BUCKET) })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req, res) => {
    const ctx = await toMemberAccessContext(req);
    const run = await startLakeResearchRun(req, req.validatedParams.id, ctx, () => ({
      configId: req.validated.config_id,
    }));
    return res.status(202).json({ data: toPublicRun(run) });
  });

export default dispatchByMethod({ GET: listRouter, POST: startRouter });

export const config = {
  api: { externalResolver: true },
};
