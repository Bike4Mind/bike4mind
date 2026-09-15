import { slackDevWorkspaceRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError, NotFoundError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

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

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const handler = baseApi()
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const workspaces = await slackDevWorkspaceRepository.findAllActive();

    Logger.info('📋 [Admin] Fetched Slack workspaces', {
      count: workspaces.length,
      adminUserId: req.user?.id,
    });

    return res.json({ workspaces });
  })
  .patch(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const result = DeactivateWorkspaceSchema.safeParse(req.body);
    if (!result.success) {
      throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
    }

    const { workspaceId } = result.data;
    // action is validated by Zod schema to be 'deactivate'

    const workspace = await slackDevWorkspaceRepository.deactivate(workspaceId);

    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

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
