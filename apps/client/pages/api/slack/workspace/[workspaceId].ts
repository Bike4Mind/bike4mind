import { slackDevWorkspaceRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError, BadRequestError } from '@server/utils/errors';

/**
 * Get workspace information by ID
 *
 * GET /api/slack/workspace/[workspaceId]
 * Returns: ISlackDevWorkspaceDocument (workspace.toJSON())
 */
const handler = baseApi().get(async (req, res) => {
  const { workspaceId } = req.query;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new BadRequestError('Workspace ID is required');
  }

  const workspace = await slackDevWorkspaceRepository.findById(workspaceId);

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  // Return workspace directly (toJSON() is already called by findById)
  return res.json(workspace);
});

export default handler;
