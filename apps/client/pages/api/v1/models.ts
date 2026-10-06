/**
 * GET /api/v1/models - the public, cursor-paginated projection of the caller's model list.
 *
 * Auth mode, the `ai:chat` / `ai:generate` scopes and query validation come from
 * `listModelsContract`. The list itself is the one GET /api/models serves (getCallerModelList),
 * mapped through `toPublicModel` so internal catalog fields never reach the wire.
 */

import { listModelsContract, toPublicModel } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { paginateById } from '@server/utils/cursorPagination';
import { getCallerModelList } from '@server/utils/callerModelList';

const CURSOR_SCOPE = 'v1.models';

const handler = nextRouteForContract(listModelsContract, {
  // Integrators re-list before choosing a model; that lookup should not burn the daily
  // budget the generation itself needs - same exemption as GET /api/v1/credits.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  const { models } = await getCallerModelList(req.user.id, req.logger);
  const page = paginateById(models, { limit, cursor, scope: CURSOR_SCOPE });

  // Built from the caller's own provider keys - never cacheable by a shared cache.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ data: page.items.map(toPublicModel), next_cursor: page.nextCursor });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
