import { secureParameters } from '@bike4mind/utils';
import { IProjectRepository, IUserDocument, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';
import * as favoriteService from '../favoriteService';

const deleteFavoriteParametersSchema = z.object({
  projectId: z.string(),
});

type DeleteFavoriteParameters = z.infer<typeof deleteFavoriteParametersSchema>;

export interface DeleteFavoriteAdapters {
  db: {
    projects: IProjectRepository;
    favorites: IFavoriteRepository;
  };
}

export const deleteFavorite = async (
  user: IUserDocument,
  parameters: DeleteFavoriteParameters,
  adapters: DeleteFavoriteAdapters
) => {
  const { db } = adapters;
  const { projectId } = secureParameters(parameters, deleteFavoriteParametersSchema);

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) {
    throw new NotFoundError('Project not found or not accessible');
  }

  return favoriteService.delete_(
    user,
    { documentId: projectId, documentType: FavoriteDocumentType.Projects },
    { db: { favorites: db.favorites } }
  );
};
