import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';

/**
 * Admin action: force-logout a user by revoking all their sessions (tokenVersion bump).
 * Authz (admin-only) is enforced inside userService.adminRevokeUserSessions, matching
 * users/[id]/delete.ts. All-device by design; see revokeSessions.ts.
 */
const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const targetId = req.query.id!;
    const tokenVersion = await userService.adminRevokeUserSessions(
      req.user.id,
      { id: targetId },
      { db: { users: userRepository }, logger: req.logger }
    );
    return res.status(200).json({ message: 'Sessions revoked', userId: targetId, tokenVersion });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
