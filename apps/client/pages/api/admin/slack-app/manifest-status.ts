import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';
import { compareManifests, extractBaseUrl } from '@bike4mind/slack';
import { isSlackUserValidationError } from '@server/integrations/slack/slackExportErrors';

/**
 * GET /api/admin/slack-app/manifest-status?workspaceId=xxx
 * Checks if a workspace's Slack app manifest is up to date with our template.
 * Admin-only endpoint.
 */

const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const workspaceId = req.query.workspaceId as string;
  if (!workspaceId) {
    throw new BadRequestError('workspaceId query parameter is required');
  }

  const workspace = await slackDevWorkspaceRepository.findByIdWithConfigToken(workspaceId);
  if (!workspace) {
    throw new BadRequestError('Workspace not found');
  }

  if (!workspace.appConfigurationToken) {
    return res.status(200).json({
      status: 'missing_token',
      message: 'No configuration token stored. Reconnect to enable manifest management.',
    });
  }

  // Export live manifest from Slack
  let slackData: Record<string, unknown>;
  try {
    const slackResponse = await fetch('https://slack.com/api/apps.manifest.export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workspace.appConfigurationToken}`,
      },
      body: JSON.stringify({ app_id: workspace.slackAppId }),
    });
    slackData = await slackResponse.json();
  } catch (fetchError) {
    req.logger.error('Network error calling Slack API (apps.manifest.export)', {
      workspaceId,
      error: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
    throw new BadRequestError('Unable to reach the Slack API. Please try again.');
  }

  if (!slackData.ok) {
    const slackError = slackData.error as string;
    const isUserError = isSlackUserValidationError(slackError || '');

    if (isUserError) {
      req.logger.warn('Slack manifest export auth error (user validation)', { error: slackError, workspaceId });
      return res.status(200).json({
        status: 'missing_token',
        message: 'Configuration token is invalid or expired. Please reconnect.',
      });
    }

    req.logger.error('Failed to export manifest from Slack', { error: slackError, workspaceId });
    throw new BadRequestError(slackError || 'Failed to export manifest from Slack');
  }

  const liveManifest = slackData.manifest as Record<string, unknown> | undefined;
  if (!liveManifest) {
    req.logger.error('Slack API returned ok but no manifest data', { workspaceId });
    throw new BadRequestError('Unexpected response from Slack: no manifest data returned');
  }

  const proto = req.headers['x-forwarded-proto'];
  const baseUrl = extractBaseUrl(
    liveManifest,
    { protocol: Array.isArray(proto) ? proto[0] : proto, host: req.headers.host },
    req.logger
  );

  const result = compareManifests(liveManifest, baseUrl, {
    enableWorkflowSteps: workspace.enableWorkflowSteps ?? true,
  });

  return res.status(200).json({
    status: result.isUpToDate ? 'up_to_date' : 'outdated',
    differences: result.differences,
  });
});

export default handler;
