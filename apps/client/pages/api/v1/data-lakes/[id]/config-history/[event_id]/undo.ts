/**
 * POST /api/v1/data-lakes/{id}/config-history/{event_id}/undo - reverse one History row
 * (`undoDataLakeConfigChangeContract`).
 *
 * Public twin of POST /api/data-lakes/:id/config-history/:eventId/undo on the same handler body.
 * Refusals (already undone, drift, expired restore record, missing config) are 409s from the service.
 */
import { undoDataLakeConfigChangeContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { undoLakeConfigChangeHandler } from '@server/dataLakes/research/undoHandler';
import { undoRateLimit } from '@server/dataLakes/research/v1Shared';
import { toPublicUndoResult } from '@server/dataLakes/toPublicResearch';

const handler = nextRouteForContract(undoDataLakeConfigChangeContract, {
  rateLimit: undoRateLimit('/api/v1/data-lakes/[id]/config-history/undo'),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req, res) => {
    const { id, event_id } = req.validatedParams;
    const result = await undoLakeConfigChangeHandler(req, id, event_id, await toMemberAccessContext(req));
    return res.json(toPublicUndoResult(result));
  });

export default handler;

export const config = {
  api: { externalResolver: true },
};
