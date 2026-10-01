import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';
import { issueStateNonce, clearStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { createInstallProvider, getInstallUrlOptionsForWorkspace } from '@bike4mind/slack';

/**
 * Slack OAuth Authorization Endpoint
 *
 * Generates the Slack OAuth URL with CSRF protection (state parameter).
 * Uses @slack/oauth for secure state generation.
 * Admin only. The state is bound to the initiating browser via a nonce cookie.
 *
 * GET /api/slack/oauth/authorize?workspaceId=<workspace_id>
 * Returns: { authUrl: string }
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  ensureAdmin(req.user.isAdmin);
  const { workspaceId } = req.query;

  if (!workspaceId || typeof workspaceId !== 'string') {
    return res.status(400).json({ error: 'Workspace ID is required' });
  }

  // Resolve the workspace first so an unknown one never gets a nonce cookie.
  const installUrlOptions = await getInstallUrlOptionsForWorkspace(workspaceId);
  const nonceHash = issueStateNonce(res, NONCE_SLOT.slackAppInstall);

  let authUrl: string;
  try {
    const installer = await createInstallProvider(workspaceId, { nonceHash });
    authUrl = await installer.generateInstallUrl(installUrlOptions);
  } catch (error) {
    clearStateNonce(res, NONCE_SLOT.slackAppInstall);
    throw error;
  }

  const scopes = installUrlOptions.scopes;
  req.logger.info('Generated Slack OAuth URL', {
    userId: req.user.id,
    workspaceId,
    redirectUri: installUrlOptions.redirectUri,
    scopes: Array.isArray(scopes) ? scopes.join(',') : scopes,
  });

  return res.status(200).json({ authUrl });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
