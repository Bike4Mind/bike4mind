import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { z } from 'zod';
import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';
import { mergeManifest, extractBaseUrl } from '@bike4mind/slack';
import { isSlackUserValidationError } from '@server/integrations/slack/slackExportErrors';

/**
 * POST /api/admin/slack-app/update-manifest
 * Exports the live manifest, merges our controlled fields, and pushes it back.
 * Only overwrites scopes, events, commands, app_home, interactivity;
 * user-customizable fields (name, description, color) are preserved.
 * Admin-only endpoint.
 */

const UpdateManifestSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
});

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const result = UpdateManifestSchema.safeParse(req.body);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
  }

  const { workspaceId } = result.data;

  const workspace = await slackDevWorkspaceRepository.findByIdWithConfigToken(workspaceId);
  if (!workspace) {
    throw new BadRequestError('Workspace not found');
  }

  if (!workspace.appConfigurationToken) {
    throw new BadRequestError('No configuration token stored. Reconnect to enable manifest management.');
  }

  // Step 1: Export live manifest from Slack
  let exportData: Record<string, unknown>;
  try {
    const exportResponse = await fetch('https://slack.com/api/apps.manifest.export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workspace.appConfigurationToken}`,
      },
      body: JSON.stringify({ app_id: workspace.slackAppId }),
    });
    exportData = await exportResponse.json();
  } catch (fetchError) {
    req.logger.error('Network error calling Slack API (apps.manifest.export)', {
      workspaceId,
      error: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
    throw new BadRequestError('Unable to reach the Slack API. Please try again.');
  }

  if (!exportData.ok) {
    const slackError = exportData.error as string;

    if (isSlackUserValidationError(slackError || '')) {
      req.logger.warn('Slack manifest export auth error (user validation)', { error: slackError, workspaceId });
      throw new BadRequestError('Configuration token is invalid or expired. Please reconnect before updating.');
    }

    req.logger.error('Failed to export manifest from Slack', { error: slackError, workspaceId });
    throw new BadRequestError(slackError || 'Failed to export manifest from Slack');
  }

  const liveManifest = exportData.manifest as Record<string, unknown> | undefined;
  if (!liveManifest) {
    req.logger.error('Slack API returned ok but no manifest data', { workspaceId });
    throw new BadRequestError('Unexpected response from Slack: no manifest data returned');
  }

  // Step 2: Determine base URL from live manifest
  const proto = req.headers['x-forwarded-proto'];
  const baseUrl = extractBaseUrl(
    liveManifest,
    { protocol: Array.isArray(proto) ? proto[0] : proto, host: req.headers.host },
    req.logger
  );

  // Step 3: Merge controlled fields into live manifest
  const mergedManifest = mergeManifest(liveManifest, baseUrl, {
    enableWorkflowSteps: workspace.enableWorkflowSteps ?? true,
  });

  // Step 4: Push updated manifest back to Slack
  let updateData: Record<string, unknown>;
  try {
    const updateResponse = await fetch('https://slack.com/api/apps.manifest.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workspace.appConfigurationToken}`,
      },
      body: JSON.stringify({
        app_id: workspace.slackAppId,
        manifest: mergedManifest,
      }),
    });
    updateData = await updateResponse.json();
  } catch (fetchError) {
    req.logger.error('Network error calling Slack API (apps.manifest.update)', {
      workspaceId,
      error: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
    throw new BadRequestError('Unable to reach the Slack API. Please try again.');
  }

  if (!updateData.ok) {
    const slackError = updateData.error as string;

    if (isSlackUserValidationError(slackError || '')) {
      req.logger.warn('Slack manifest update auth error (user validation)', { error: slackError, workspaceId });
      throw new BadRequestError('Configuration token is invalid or expired. Please reconnect before updating.');
    }

    req.logger.error('Failed to update manifest on Slack', {
      error: slackError,
      errors: updateData.errors,
      workspaceId,
    });
    throw new BadRequestError(
      slackError || 'Failed to update manifest on Slack',
      (updateData.errors || updateData.response_metadata) as Record<string, unknown> | undefined
    );
  }

  req.logger.info('✨ [Admin] Updated Slack app manifest', {
    workspaceId,
    appId: workspace.slackAppId,
    adminUserId: req.user?.id,
  });

  return res.status(200).json({
    success: true,
    message: 'Manifest updated successfully',
  });
});

export default handler;
