import { secureParameters } from '@bike4mind/utils';
import { IUserDocument, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';

const deleteFavoriteParametersSchema = z.object({
  documentId: z.string(),
  documentType: z.enum(FavoriteDocumentType),
});

type DeleteFavoriteParameters = z.infer<typeof deleteFavoriteParametersSchema>;

export interface DeleteFavoriteAdapters {
  db: {
    favorites: IFavoriteRepository;
  };
}

export const delete_ = async (
  user: IUserDocument,
  parameters: DeleteFavoriteParameters,
  adapters: DeleteFavoriteAdapters
) => {
  const { db } = adapters;
  const { documentId, documentType } = secureParameters(parameters, deleteFavoriteParametersSchema);

  const favorite = await db.favorites.findOne({
    userId: user.id,
    documentId,
    documentType,
  });

  if (!favorite) {
    throw new NotFoundError('Favorite not found');
  }

  await db.favorites.delete(favorite.id);
  return favorite;
};
