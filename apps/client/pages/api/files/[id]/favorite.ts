import { FavoriteDocumentType } from '@bike4mind/common';
import { fabFileRepository, favoriteRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { FILES_WRITE_SCOPES } from '@bike4mind/server-utils/files/fileScopes';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';

/**
 * Star (POST) or unstar (DELETE) a file for the caller. Stars are the shared `Favorite` entity with
 * documentType `files`. Both are idempotent, so a second tab with a stale star state never errors.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: FILES_WRITE_SCOPES })
  .post(async (req, res) => {
    const fileId = req.query.id as string;
    try {
      // The service 404s a file the caller cannot access.
      const favorite = await fabFilesService.addFavorite(
        req.user,
        { fileId },
        { db: { fabFiles: fabFileRepository, favorites: favoriteRepository } }
      );
      return res.json(favorite);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await favoriteRepository.findOne({
        userId: req.user.id,
        documentId: fileId,
        documentType: FavoriteDocumentType.Files,
      });
      return res.json(existing);
    }
  })
  // Removing your own star needs no access to the file: a star on a file since unshared must still go.
  .delete(async (req, res) => {
    const favorite = await favoriteRepository.findOne({
      userId: req.user.id,
      documentId: req.query.id as string,
      documentType: FavoriteDocumentType.Files,
    });
    if (favorite) await favoriteRepository.delete(favorite.id);
    return res.json({ removed: Boolean(favorite) });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
