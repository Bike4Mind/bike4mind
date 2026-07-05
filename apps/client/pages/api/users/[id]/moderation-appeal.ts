import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';

/**
 * Submit an appeal against a moderation action on the account.
 * Self-service: a user may only appeal their own account (admins may appeal on behalf of any user).
 * Records the appeal for admin review; an admin then lifts or confirms the escalation.
 */
const handler = baseApi().post(
  asyncHandler<{}, unknown, { appealText?: string }, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;
    const currentUser = req.user;

    // A user may only appeal their own account.
    if (!currentUser.isAdmin && currentUser.id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { appealText } = req.body;

    const updatedUser = await userService.requestModerationAppeal(userId, appealText ?? '', {
      db: { users: userRepository },
    });

    return res.status(200).json({
      success: true,
      appealedAt: updatedUser?.moderation?.appealedAt ?? null,
      status: updatedUser?.moderation?.status ?? null,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
