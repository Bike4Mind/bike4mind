import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { readStateNonceHash, clearStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import {
  authorizeGitHubLakeConnection,
  requireGitHubLakeAppConfig,
} from '@server/integrations/github/dataLake/githubLakeConnection';
import { parseOrBadRequest } from '@server/utils/errors';
import { Request } from 'express';
import { z } from 'zod';

// The query GitHub appends to the App's callback URL, relayed by the SPA page it lands on.
const Body = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
});

/**
 * POST /api/data-lakes/github-callback -> 200 { dataLakeId }
 *
 * The authorize leg of a connect started by POST /api/data-lakes/:id/github-connection (and the
 * install fallback's return, which carries the same `state`). Exchanges GitHub's `code` and holds the
 * user token server-side for the repository picker; binds nothing (see authorizeGitHubLakeConnection).
 * Authed like google-drive/callback.ts: GitHub redirects the browser to an SPA page, which relays the
 * query here with the session, so the state's user can be matched against a real req.user.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(requireFeatureEnabled('EnableDataLakeGitHub'))
  .post(async (req: Request, res) => {
    try {
      const { state, code } = parseOrBadRequest(Body, req.body);
      const result = await authorizeGitHubLakeConnection({
        config: requireGitHubLakeAppConfig(getGitHubLakeAppConfig()),
        user: req.user,
        state,
        code,
        nonceHash: readStateNonceHash(req, NONCE_SLOT.githubLakeConnect),
      });
      return res.json(result);
    } catch (error) {
      // The nonce keys the held token, so it lives on through the picker; a failed exchange burns it
      // so the flow restarts rather than being replayed from this browser.
      clearStateNonce(res, NONCE_SLOT.githubLakeConnect);
      throw error;
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
