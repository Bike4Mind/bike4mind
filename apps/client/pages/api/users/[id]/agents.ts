import { Agent } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';

/**
 * GET /api/users/[id]/agents
 * Returns agents accessible to this user (own agents + shared agents)
 * Used by Slack integration settings to populate custom agent selector
 */
const handler = baseApi().get(async (req, res) => {
  const userId = req.query.id as string;
  const requestingUserId = req.user?.id;

  // Users can only view their own agents (or admins can view any)
  if (userId !== requestingUserId && !req.user?.isAdmin) {
    throw new ForbiddenError('Not authorized to view these agents');
  }

  const agents = await Agent.find({
    $or: [{ userId }, { 'users.userId': userId }],
    deletedAt: { $exists: false },
  })
    .select('name description')
    .sort({ name: 1 });

  return res.status(200).json({
    agents: agents.map(a => ({
      id: a._id.toString(),
      name: a.name,
      description: a.description,
    })),
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
