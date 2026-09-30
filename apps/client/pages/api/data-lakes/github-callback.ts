import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { consumeStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import {
  completeGitHubLakeConnection,
  requireGitHubLakeAppConfig,
  toGitHubLakeConnectionResponse,
  verifyGitHubLakeState,
} from '@server/integrations/github/dataLake/githubLakeConnection';
import { parseOrBadRequest } from '@server/utils/errors';
import { Request } from 'express';
import { z } from 'zod';

// The query GitHub appends to the App's callback URL, relayed by the SPA page it lands on.
const Body = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
  installationId: z.coerce.number().int().positive(),
});

/**
 * POST /api/data-lakes/github-callback -> 201 { connection }
 *
 * Completes a GitHub App install started by POST /api/data-lakes/:id/github-connection. Authed like
 * google-drive/callback.ts: GitHub redirects the browser to an SPA page, which relays the query here
 * with the session, so the state's user can be matched against a real req.user. The lake comes from
 * the signed state, never the body.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(requireFeatureEnabled('EnableDataLakeGitHub'))
  .post(async (req: Request, res) => {
    const nonceHash = consumeStateNonce(req, res, NONCE_SLOT.githubLakeConnect); // burn before parse, which can 400
    const { state, code, installationId } = parseOrBadRequest(Body, req.body);
    const dataLakeId = verifyGitHubLakeState(state, nonceHash, req.user.id);
    const conn = await completeGitHubLakeConnection({
      config: requireGitHubLakeAppConfig(getGitHubLakeAppConfig()),
      user: req.user,
      dataLakeId,
      installationId,
      code,
      logger: req.logger,
    });
    return res.status(201).json({ connection: toGitHubLakeConnectionResponse(conn) });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
