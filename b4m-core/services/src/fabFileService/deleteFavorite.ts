import { secureParameters } from '@bike4mind/utils';
import { IFabFileRepository, IUserDocument, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';
import * as favoriteService from '../favoriteService';

const deleteFavoriteParametersSchema = z.object({
  fileId: z.string(),
});

type DeleteFavoriteParameters = z.infer<typeof deleteFavoriteParametersSchema>;

export interface DeleteFavoriteAdapters {
  db: {
    fabFiles: IFabFileRepository;
    favorites: IFavoriteRepository;
  };
}

export const deleteFavorite = async (
  user: IUserDocument,
  parameters: DeleteFavoriteParameters,
  adapters: DeleteFavoriteAdapters
) => {
  const { db } = adapters;
  const { fileId } = secureParameters(parameters, deleteFavoriteParametersSchema);

  // Verify file exists and user has access
  const file = await db.fabFiles.shareable.findAccessibleById(user, fileId);
  if (!file) {
    throw new NotFoundError('File not found or not accessible');
  }

  return favoriteService.delete_(
    user,
    { documentId: fileId, documentType: FavoriteDocumentType.Files },
    { db: { favorites: db.favorites } }
  );
};
