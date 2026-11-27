/**
 * GET /api/v1/data-lakes/{id}/proposals - the lake's acquisition review queue (`listDataLakeProposalsContract`).
 *
 * Public twin of GET /api/data-lakes/:id/proposals on the same handler body, recorded in the lake's
 * access history under its own surface so integrator reads can be told from the product UI's.
 * Manage-gated: a caller who can only read the lake gets a 403.
 */
import { listDataLakeProposalsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { listLakeProposals } from '@server/dataLakes/research/proposalListHandler';
import { cursorScope, keysetWindow, researchRateLimit, sliceKeysetPage } from '@server/dataLakes/research/v1Shared';
import { toPublicProposal } from '@server/dataLakes/toPublicResearch';

const handler = nextRouteForContract(listDataLakeProposalsContract, {
  rateLimit: researchRateLimit('/api/v1/data-lakes/[id]/proposals'),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const lakeId = req.validatedParams.id;
    const { limit, status } = req.validatedQuery;
    const scope = cursorScope('data-lake-proposals', `${lakeId}:${status ?? 'all'}`);
    const proposals = await listLakeProposals(
      req,
      lakeId,
      await toMemberAccessContext(req),
      'data-lake-api-v1-proposals',
      () => ({ status, servedLimit: limit, ...keysetWindow(scope, req.validatedQuery) })
    );
    const page = sliceKeysetPage(proposals, limit, scope);
    return res.json({ data: page.items.map(toPublicProposal), next_cursor: page.next_cursor });
  });

export default handler;

export const config = {
  api: { externalResolver: true },
};
