import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

/**
 * Organization Slack Workspace - Start OAuth Connect Flow
 *
 * POST /api/organizations/[id]/integrations/slack/connect
 *
 * Returns a Slack OAuth URL that the org owner should redirect to.
 * Uses the system's existing Slack app credentials.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { BadRequestError } from '@bike4mind/utils';
import { verifyOrgOwner } from '@server/utils/orgAccess';
import {
  getSystemSlackAppCredentials,
  generateOrgSlackConnectStateToken,
  buildOrgSlackOAuthUrl,
} from '@bike4mind/slack';
import { issueStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';

const handler = baseApi().post(
  asyncHandler<{}, { url: string }, unknown, { id?: string }>(async (req, res) => {
    const orgId = req.query.id!;
    const user = req.user!;

    // Owner-only, matching the sibling index.ts arms: connecting a workspace wires Slack to the
    // whole tenant. Behaviour is identical to the inline check this replaces apart from a
    // malformed id now answering 400 rather than 404.
    await verifyOrgOwner(user, orgId);

    const existing = await orgSlackWorkspaceRepository.findByOrganizationId(orgId);
    if (existing) {
      throw new BadRequestError('A Slack workspace is already connected to this organization');
    }

    const appCredentials = await getSystemSlackAppCredentials();
    if (!appCredentials) {
      throw new BadRequestError('Slack integration is not configured. Please contact support.');
    }

    // Bind the flow to this browser: the state carries the nonce-cookie hash the
    // callback re-checks (issueStateNonce sets the cookie on res).
    const state = generateOrgSlackConnectStateToken(orgId, user.id, issueStateNonce(res, NONCE_SLOT.orgSlackConnect));

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const redirectUri = `${baseUrl}/api/slack/oauth/org-connect/callback`;

    const url = buildOrgSlackOAuthUrl(appCredentials.clientId, redirectUri, state);

    return res.status(200).json({ url });
  })
);

export default handler;
