import { secureParameters } from '@bike4mind/utils';
import { IProjectRepository, IUserDocument, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';
import { create as createFavorite } from '../favoriteService';

const addFavoriteParametersSchema = z.object({
  projectId: z.string(),
});

type AddFavoriteParameters = z.infer<typeof addFavoriteParametersSchema>;

export interface AddFavoriteAdapters {
  db: {
    projects: IProjectRepository;
    favorites: IFavoriteRepository;
  };
}

export const addFavorite = async (
  user: IUserDocument,
  parameters: AddFavoriteParameters,
  adapters: AddFavoriteAdapters
) => {
  const { db } = adapters;
  const { projectId } = secureParameters(parameters, addFavoriteParametersSchema);

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) {
    throw new NotFoundError('Project not found or not accessible');
  }

  return createFavorite(
    user,
    { documentId: projectId, documentType: FavoriteDocumentType.Projects },
    { db: { favorites: db.favorites } }
  );
};
