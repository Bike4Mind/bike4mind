import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@bike4mind/server-utils/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { dataLakeResearchService } from '@bike4mind/services';
import { researchConfigEnvelopeResponseSchema, withResearchFeedStatus } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import {
  UpdateResearchConfigInput,
  deleteLakeResearchConfig,
  updateLakeResearchConfig,
} from '@server/dataLakes/research/researchConfigHandlers';
import { respond } from '@server/utils/respond';

/**
 * PUT    /api/data-lakes/:id/research/configs/:configId - edit a saved configuration (#1682).
 * DELETE /api/data-lakes/:id/research/configs/:configId - remove it.
 *
 * The lake from the path is resolved and manage-gated, then passed to the service, which scopes
 * every read and write to it. That pairing is what stops a caller who manages lake A from reaching
 * lake B's config by id - the repository filters on `dataLakeId`, not just on `_id`.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .put(async (req: Request, res) => {
    const { id, configId } = req.query as { id: string; configId: string };
    // Resolved outside the transaction: it issues concurrent reads, which an ambient session rejects.
    const ctx = await toAccessContext(req);

    const updated = await updateLakeResearchConfig(req, id, configId, ctx, () =>
      UpdateResearchConfigInput.parse(req.body)
    );
    return respond(res, researchConfigEnvelopeResponseSchema, {
      data: withResearchFeedStatus(updated, dataLakeResearchService.feedFingerprintLevers(updated)),
    });
  })
  .delete(async (req: Request, res) => {
    const { id, configId } = req.query as { id: string; configId: string };
    const ctx = await toAccessContext(req);

    await deleteLakeResearchConfig(req, id, configId, ctx);
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
