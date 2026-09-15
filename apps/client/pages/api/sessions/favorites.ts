import { getFavoriteSessionByUser } from '@server/managers/sessionManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    try {
      const result = req.user ? await getFavoriteSessionByUser(req.user.id) : [];
      return res.json(result);
    } catch (err) {
      console.error(err);
      return res.status(400).json({ message: 'Failed to get sessions', error: err });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
