import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { clearStateNonce, readStateNonceHash, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import {
  completeGitHubLakeConnection,
  requireGitHubLakeAppConfig,
  toGitHubLakeConnectionResponse,
} from '@server/integrations/github/dataLake/githubLakeConnection';
import { parseOrBadRequest } from '@server/utils/errors';
import { Request } from 'express';
import { z } from 'zod';

const Body = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
});

/**
 * POST /api/data-lakes/:id/github-connection/complete -> 201 { connection }
 *
 * Binds the repository picked from GET .../repositories. The pick is re-verified against the flow's
 * user token server-side (completeGitHubLakeConnection), so the client cannot name a repository its
 * user cannot see. A failure keeps the flow alive so the user can pick again.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(requireFeatureEnabled('EnableDataLakeGitHub'))
  .post(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { installationId, repositoryId } = parseOrBadRequest(Body, req.body);
    const conn = await completeGitHubLakeConnection({
      config: requireGitHubLakeAppConfig(getGitHubLakeAppConfig()),
      user: req.user,
      dataLakeId: id,
      nonceHash: readStateNonceHash(req, NONCE_SLOT.githubLakeConnect),
      installationId,
      repositoryId,
      logger: req.logger,
    });
    clearStateNonce(res, NONCE_SLOT.githubLakeConnect);
    // A connection minted just now has ingested nothing: its first sync is only enqueued.
    return res.status(201).json({ connection: toGitHubLakeConnectionResponse(conn, 0) });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
