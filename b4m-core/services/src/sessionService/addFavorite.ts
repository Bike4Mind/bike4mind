import { secureParameters } from '@bike4mind/utils';
import { ISessionRepository, IUserDocument, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import { z } from 'zod';
import { NotFoundError } from '@bike4mind/utils';
import { create as createFavorite } from '../favoriteService';

const addFavoriteParametersSchema = z.object({
  sessionId: z.string(),
});

type AddFavoriteParameters = z.infer<typeof addFavoriteParametersSchema>;

export interface AddFavoriteAdapters {
  db: {
    sessions: ISessionRepository;
    favorites: IFavoriteRepository;
  };
}

export const addFavorite = async (
  user: IUserDocument,
  parameters: AddFavoriteParameters,
  adapters: AddFavoriteAdapters
) => {
  const { db } = adapters;
  const { sessionId } = secureParameters(parameters, addFavoriteParametersSchema);

  // Verify session exists and user has access
  const session = await db.sessions.shareable.findAccessibleById(user, sessionId);
  if (!session) {
    throw new NotFoundError('Session not found or not accessible');
  }

  return createFavorite(
    user,
    { documentId: sessionId, documentType: FavoriteDocumentType.Sessions },
    { db: { favorites: db.favorites } }
  );
};
