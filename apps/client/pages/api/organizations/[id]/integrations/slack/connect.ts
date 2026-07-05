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
import { organizationRepository } from '@bike4mind/database/infra';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import {
  getSystemSlackAppCredentials,
  generateOrgSlackConnectStateToken,
  buildOrgSlackOAuthUrl,
} from '@bike4mind/slack';

const handler = baseApi().post(
  asyncHandler<{}, { url: string }, unknown, { id?: string }>(async (req, res) => {
    const orgId = req.query.id!;
    const user = req.user!;

    // Only org owner or system admin
    if (!user.isAdmin) {
      const org = await organizationRepository.findById(orgId);
      if (!org) throw new NotFoundError('Organization not found');
      if (org.userId !== user.id) throw new NotFoundError('Organization not found');
    } else {
      const org = await organizationRepository.findById(orgId);
      if (!org) throw new NotFoundError('Organization not found');
    }

    const existing = await orgSlackWorkspaceRepository.findByOrganizationId(orgId);
    if (existing) {
      throw new BadRequestError('A Slack workspace is already connected to this organization');
    }

    const appCredentials = await getSystemSlackAppCredentials();
    if (!appCredentials) {
      throw new BadRequestError('Slack integration is not configured. Please contact support.');
    }

    const state = generateOrgSlackConnectStateToken(orgId, user.id);

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const redirectUri = `${baseUrl}/api/slack/oauth/org-connect/callback`;

    const url = buildOrgSlackOAuthUrl(appCredentials.clientId, redirectUri, state);

    return res.status(200).json({ url });
  })
);

export default handler;
