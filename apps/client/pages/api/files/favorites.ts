import { FavoriteDocumentType } from '@bike4mind/common';
import { favoriteRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { FILES_READ_SCOPES } from '@bike4mind/server-utils/files/fileScopes';

/** The ids of the files the caller starred, so a file grid can mark them without a request per tile. */
const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).get(async (req, res) => {
  const favorites = await favoriteRepository.find({ userId: req.user.id, documentType: FavoriteDocumentType.Files });
  return res.json({ fileIds: favorites.map(favorite => favorite.documentId) });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
