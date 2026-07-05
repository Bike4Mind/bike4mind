import { IBaseRepository } from './BaseTypes';

/** Valid document types that can be favorited */
export enum FavoriteDocumentType {
  Sessions = 'sessions',
  Files = 'files',
  Projects = 'projects',
}

export interface IFavorite {
  /** The id of the favorite */
  id: string;

  /** The id of the user who favorited the document */
  userId: string;

  /** The id of the document that is favorited */
  documentId: string;

  /** The type of the document that is favorited */
  documentType: FavoriteDocumentType;

  /** The date the favorite was created */
  createdAt: Date;

  /** The date the favorite was last updated */
  updatedAt: Date;
}

/**
 * The repository for the Favorite entity
 */
export interface IFavoriteRepository extends IBaseRepository<IFavorite> {}
