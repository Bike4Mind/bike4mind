import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { baseApi } from '@server/middlewares/baseApi';
import { createInstallProvider, getInstallUrlOptionsForWorkspace } from '@bike4mind/slack';

/**
 * Slack OAuth Authorization Endpoint
 *
 * Generates the Slack OAuth URL with CSRF protection (state parameter).
 * Uses @slack/oauth for secure state generation.
 * Requires authentication - only logged-in users (typically admins) should
 * initiate Slack workspace installations.
 *
 * GET /api/slack/oauth/authorize?workspaceId=<workspace_id>
 * Returns: { authUrl: string }
 */
const handler = baseApi().get(async (req, res) => {
  const { workspaceId } = req.query;

  if (!workspaceId || typeof workspaceId !== 'string') {
    return res.status(400).json({ error: 'Workspace ID is required' });
  }

  const installer = await createInstallProvider(workspaceId);
  const installUrlOptions = await getInstallUrlOptionsForWorkspace(workspaceId);

  const authUrl = await installer.generateInstallUrl(installUrlOptions);

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
