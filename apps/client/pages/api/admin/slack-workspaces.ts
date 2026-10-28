import { slackDevWorkspaceRepository, withTransaction } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * Admin API for managing Slack OAuth workspaces
 *
 * GET: List all connected workspaces
 * PATCH: Deactivate a workspace by workspace ID (soft delete)
 */

const DeactivateWorkspaceSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  action: z.literal('deactivate'),
});

const handler = adminApi({
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'settings:manage', PATCH: 'settings:manage' },
})
  .get(async (req, res) => {
    const workspaces = await slackDevWorkspaceRepository.findAllActive();

    Logger.info('📋 [Admin] Fetched Slack workspaces', {
      count: workspaces.length,
      adminUserId: req.user?.id,
    });

    return res.json({ workspaces });
  })
  .patch(async (req, res) => {
    const result = DeactivateWorkspaceSchema.safeParse(req.body);
    if (!result.success) {
      throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
    }

    const { workspaceId } = result.data;
    // action is validated by Zod schema to be 'deactivate'

    const workspace = await withTransaction(async () => {
      const deactivated = await slackDevWorkspaceRepository.deactivate(workspaceId);

      if (!deactivated) {
        throw new NotFoundError('Workspace not found');
      }

      await recordAdminActionFromRequest(req, {
        action: 'integration.slack_workspace.deactivated',
        target: { kind: 'settings', id: deactivated.id, displayName: deactivated.name || deactivated.slackAppId },
        summary: `deactivated slack workspace ${deactivated.name || deactivated.id}`,
        details: { slackTeamId: deactivated.slackTeamId, appId: deactivated.slackAppId },
      });
      return deactivated;
    });

    Logger.info('🗑️ [Admin] Deactivated Slack workspace', {
      workspaceId,
      slackTeamId: workspace.slackTeamId,
      workspaceName: workspace.name,
      adminUserId: req.user?.id,
    });

    return res.json({
      message: 'Workspace deactivated successfully',
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slackTeamId: workspace.slackTeamId,
        isActive: workspace.isActive,
      },
    });
  });

export default handler;
