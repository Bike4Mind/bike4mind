import { fabFileRepository, favoriteRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { FILES_WRITE_SCOPES } from '@bike4mind/server-utils/files/fileScopes';

const adapters = { db: { fabFiles: fabFileRepository, favorites: favoriteRepository } };

/**
 * Star (POST) or unstar (DELETE) a file for the caller. Stars are the shared `Favorite` entity with
 * documentType `files`; the service 404s a file the caller cannot access.
 */
const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES })
  .post(async (req, res) => {
    const favorite = await fabFilesService.addFavorite(req.user, { fileId: req.query.id as string }, adapters);
    return res.json(favorite);
  })
  .delete(async (req, res) => {
    const deleted = await fabFilesService.deleteFavorite(req.user, { fileId: req.query.id as string }, adapters);
    return res.json(deleted);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
