import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository, fabFileRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;
    const currentUser = req.user;

    if (!currentUser.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { counter, truth, drift, repaired } = await userService.recalculateUserStorage(
      { userId },
      {
        db: {
          users: userRepository,
          fabFiles: fabFileRepository,
        },
      }
    );
    const user = await userRepository.findById(userId);

    await recordAdminActionFromRequest(req, {
      action: 'user.storage.recalculated',
      target: { kind: 'user', id: userId, displayName: user?.email ?? user?.username ?? userId },
      summary: repaired ? `recalculated storage, corrected drift of ${drift}` : 'recalculated storage, no drift',
      changes: repaired ? [{ field: 'currentStorageSize', before: counter, after: truth }] : undefined,
      details: { drift, repaired },
    });

    return res.status(200).json({
      success: true,
      currentStorageSize: truth,
      storageLimit: user?.storageLimit || 0,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
