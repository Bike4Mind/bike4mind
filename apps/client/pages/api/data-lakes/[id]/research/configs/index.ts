import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@bike4mind/server-utils/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { dataLakeResearchService } from '@bike4mind/services';
import { Request } from 'express';
import {
  researchConfigEnvelopeResponseSchema,
  researchConfigListResponseSchema,
  withResearchFeedStatus,
} from '@bike4mind/common';
import { toAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import {
  CreateResearchConfigInput,
  createLakeResearchConfig,
  listLakeResearchConfigs,
} from '@server/dataLakes/research/researchConfigHandlers';
import { respond } from '@server/utils/respond';

/**
 * GET  /api/data-lakes/:id/research/configs - the lake's saved research configurations (#1682).
 * POST /api/data-lakes/:id/research/configs - save a new one.
 *
 * Manage-gated on both verbs (see `assertLakeResearchManage`). Bounds and normalization live in the
 * service, not here, so a config written through any future second path means the same thing. The
 * handler bodies are shared with the public v1 routes (`server/dataLakes/research`).
 *
 * The GET also returns the lake's live `pendingProposals` - the same count the research scheduler
 * compares against each config's `reviewBacklogLimit` - so the panel can say scheduling is held.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { configs, pendingProposals } = await listLakeResearchConfigs(req, id, await toAccessContext(req));
    return respond(res, researchConfigListResponseSchema, {
      data: configs.map(c => withResearchFeedStatus(c, dataLakeResearchService.feedFingerprintLevers(c))),
      pendingProposals,
    });
  })
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query as { id: string };
    // Resolved outside the transaction: it issues concurrent reads, which an ambient session rejects.
    const ctx = await toAccessContext(req);

    const config = await createLakeResearchConfig(req, id, ctx, () => CreateResearchConfigInput.parse(req.body));
    return respond(
      res,
      researchConfigEnvelopeResponseSchema,
      { data: withResearchFeedStatus(config, dataLakeResearchService.feedFingerprintLevers(config)) },
      201
    );
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
