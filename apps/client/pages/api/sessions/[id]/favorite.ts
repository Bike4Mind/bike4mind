import { baseApi } from '@server/middlewares/baseApi';
import { sessionService } from '@bike4mind/services';
import { sessionRepository, favoriteRepository } from '@bike4mind/database';

const handler = baseApi()
  .post(async (req, res) => {
    const id = req.query.id as string;
    const favorite = await sessionService.addFavorite(
      req.user,
      { sessionId: id },
      {
        db: {
          sessions: sessionRepository,
          favorites: favoriteRepository,
        },
      }
    );

    return res.json(favorite);
  })
  .delete(async (req, res) => {
    const id = req.query.id as string;
    const deleted = await sessionService.deleteFavorite(
      req.user,
      { sessionId: id },
      {
        db: {
          sessions: sessionRepository,
          favorites: favoriteRepository,
        },
      }
    );

    return res.json(deleted);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
