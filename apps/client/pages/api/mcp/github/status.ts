import { mcpServerRepository, userRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';

// Security fix: this used to be a raw NextApiRequest with no auth - any
// unauthenticated caller could probe whether a given userId had GitHub
// connected, leak their GitHub login + connection date, and enumerate users
// via 404 vs 200. Now scoped to the requesting user's own status.
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const mcpServer = await mcpServerRepository.findOne({
      userId,
      name: McpServerName.Github,
    });

    if (!mcpServer || !mcpServer.enabled) {
      return res.status(200).json({ connected: false });
    }

    return res.status(200).json({
      connected: true,
      githubLogin: mcpServer.metadata?.githubLogin,
      connectedAt: mcpServer.metadata?.connectedAt,
      lastRotationInitiatedAt: user.integrationRotation?.github?.lastRotationInitiatedAt ?? null,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
