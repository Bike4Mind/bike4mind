import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository, fabFileRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;
    const currentUser = req.user;

    if (!currentUser.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await userService.recalculateUserStorage(
      { userId },
      {
        db: {
          users: userRepository,
          fabFiles: fabFileRepository,
        },
      }
    );

    // Fetch the updated user to return the new storage values
    const updatedUser = await userRepository.findById(userId);

    return res.status(200).json({
      success: true,
      currentStorageSize: updatedUser?.currentStorageSize || 0,
      storageLimit: updatedUser?.storageLimit || 0,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
