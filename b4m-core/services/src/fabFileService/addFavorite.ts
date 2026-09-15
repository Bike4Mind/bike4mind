import { secureParameters } from '@bike4mind/utils';
import { IFabFileRepository, IUserDocument, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';
import { create as createFavorite } from '../favoriteService';

const addFavoriteParametersSchema = z.object({
  fileId: z.string(),
});

type AddFavoriteParameters = z.infer<typeof addFavoriteParametersSchema>;

export interface AddFavoriteAdapters {
  db: {
    fabFiles: IFabFileRepository;
    favorites: IFavoriteRepository;
  };
}

export const addFavorite = async (
  user: IUserDocument,
  parameters: AddFavoriteParameters,
  adapters: AddFavoriteAdapters
) => {
  const { db } = adapters;
  const { fileId } = secureParameters(parameters, addFavoriteParametersSchema);

  // Verify file exists and user has access
  const file = await db.fabFiles.shareable.findAccessibleById(user, fileId);
  if (!file) {
    throw new NotFoundError('File not found or not accessible');
  }

  return createFavorite(
    user,
    { documentId: fileId, documentType: FavoriteDocumentType.Files },
    { db: { favorites: db.favorites } }
  );
};
