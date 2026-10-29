import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';
import { withTransaction } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * POST /api/admin/slack-app/reconnect
 * Stores an app configuration token for an existing workspace,
 * enabling manifest management for workspaces created before this feature.
 * Validates the token by attempting to export the manifest.
 * Admin-only endpoint.
 */

const ReconnectSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  configToken: z.string().min(1, 'configToken is required'),
});

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const result = ReconnectSchema.safeParse(req.body);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
  }

  const { workspaceId, configToken } = result.data;

  const workspace = await slackDevWorkspaceRepository.findById(workspaceId);
  if (!workspace) {
    throw new BadRequestError('Workspace not found');
  }

  // Validate token by attempting to export the manifest
  let slackData: Record<string, unknown>;
  try {
    const slackResponse = await fetch('https://slack.com/api/apps.manifest.export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${configToken}`,
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
    req.logger.error('Config token validation failed', {
      error: slackData.error,
      workspaceId,
    });
    throw new BadRequestError(
      `Invalid configuration token: ${(slackData.error as string) || "Token could not access this app's manifest"}`
    );
  }

  // Token is valid, store it
  await withTransaction(async () => {
    const updated = await slackDevWorkspaceRepository.storeConfigToken(workspaceId, configToken);
    if (!updated) {
      throw new BadRequestError('Workspace not found or was deleted. Please refresh and try again.');
    }

    await recordAdminActionFromRequest(req, {
      action: 'integration.slack_app.reconnected',
      target: { kind: 'settings', id: workspaceId, displayName: workspace.name || workspace.slackAppId },
      summary: `reconnected slack app ${workspace.slackAppId}`,
      details: { appId: workspace.slackAppId },
    });
  });

  req.logger.info('✨ [Admin] Stored config token for workspace', {
    workspaceId,
    appId: workspace.slackAppId,
    adminUserId: req.user?.id,
  });

  return res.status(200).json({
    success: true,
    message: 'Configuration token stored successfully. Manifest management is now enabled.',
  });
});

export default handler;
