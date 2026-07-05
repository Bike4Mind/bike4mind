import { secureParameters } from '@bike4mind/utils';
import { ISessionRepository, IUserDocument, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';
import * as favoriteService from '../favoriteService';

const deleteFavoriteParametersSchema = z.object({
  sessionId: z.string(),
});

type DeleteFavoriteParameters = z.infer<typeof deleteFavoriteParametersSchema>;

export interface DeleteFavoriteAdapters {
  db: {
    sessions: ISessionRepository;
    favorites: IFavoriteRepository;
  };
}

export const deleteFavorite = async (
  user: IUserDocument,
  parameters: DeleteFavoriteParameters,
  adapters: DeleteFavoriteAdapters
) => {
  const { db } = adapters;
  const { sessionId } = secureParameters(parameters, deleteFavoriteParametersSchema);

  // Verify session exists and user has access
  const session = await db.sessions.shareable.findAccessibleById(user, sessionId);
  if (!session) {
    throw new NotFoundError('Session not found or not accessible');
  }

  return favoriteService.delete_(
    user,
    { documentId: sessionId, documentType: FavoriteDocumentType.Sessions },
    { db: { favorites: db.favorites } }
  );
};
