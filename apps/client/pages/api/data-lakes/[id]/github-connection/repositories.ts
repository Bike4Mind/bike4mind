import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { readStateNonceHash, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import {
  listGitHubLakeRepositoryChoices,
  requireGitHubLakeAppConfig,
} from '@server/integrations/github/dataLake/githubLakeConnection';
import { Request } from 'express';

/**
 * GET /api/data-lakes/:id/github-connection/repositories -> GitHubLakeRepositoryChoicesResponse
 *
 * The repository picker's list, read with the user token held by this browser's connect flow
 * (POST /api/data-lakes/github-callback). 403 once that flow has expired: the user connects again.
 * Write-scoped because it is a step of the connect, and the lake checks are the connect's own.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(requireFeatureEnabled('EnableDataLakeGitHub'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const choices = await listGitHubLakeRepositoryChoices({
      config: requireGitHubLakeAppConfig(getGitHubLakeAppConfig()),
      user: req.user,
      dataLakeId: id,
      nonceHash: readStateNonceHash(req, NONCE_SLOT.githubLakeConnect),
    });
    return res.json(choices);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
