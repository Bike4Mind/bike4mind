import { secureParameters } from '@bike4mind/utils';
import { IUserDocument, IFavorite, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import { z } from 'zod';

const createFavoriteParametersSchema = z.object({
  documentId: z.string(),
  documentType: z.enum(FavoriteDocumentType),
});

type CreateFavoriteParameters = z.infer<typeof createFavoriteParametersSchema>;

export interface CreateFavoriteAdapters {
  db: {
    favorites: IFavoriteRepository;
  };
}

export const create = async (
  user: IUserDocument,
  parameters: CreateFavoriteParameters,
  adapters: CreateFavoriteAdapters
) => {
  const { db } = adapters;
  const { documentId, documentType } = secureParameters(parameters, createFavoriteParametersSchema);

  const favorite: Omit<IFavorite, 'id'> = {
    userId: user.id,
    documentId,
    documentType,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return await db.favorites.create(favorite);
};
