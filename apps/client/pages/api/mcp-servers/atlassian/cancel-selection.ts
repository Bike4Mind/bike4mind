import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { userRepository } from '@bike4mind/database';

/**
 * POST /api/mcp-servers/atlassian/cancel-selection
 *
 * Allows users to explicitly cancel a pending site selection.
 * This clears the atlassianConnect data, allowing them to start fresh.
 *
 * Prerequisites:
 * - User must be authenticated
 * - User must have atlassianConnect with status 'pending_site_selection'
 *
 * Response:
 * - 200: { success: true }
 * - 400: No pending site selection to cancel
 */

const handler = baseApi().post(async (req, res) => {
  const userId = req.user.id;

  const user = await userRepository.findById(userId);

  if (!user) {
    throw new BadRequestError('User not found');
  }

  if (!user.atlassianConnect) {
    throw new BadRequestError('No Atlassian connection found to cancel.');
  }

  if (user.atlassianConnect.status !== 'pending_site_selection') {
    throw new BadRequestError(
      'Cannot cancel - Atlassian is not in pending site selection state. Current status: ' +
        (user.atlassianConnect.status || 'connected')
    );
  }

  await userRepository.update({
    id: userId,
    atlassianConnect: null,
  });

  console.log(`[Atlassian Cancel Selection] User ${userId} cancelled pending site selection`);

  res.status(200).json({
    success: true,
  });
});

export default handler;
