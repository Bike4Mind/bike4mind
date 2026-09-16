import { z } from 'zod';
import { IUserDocument } from './UserTypes';
import { IMongoDocument } from './common';

export enum Permission {
  read = 'read',
  create = 'create',
  update = 'update',
  delete = 'delete',
  share = 'share',
}

export enum InvitePermission {
  acceptOrRefuse = 'acceptOrRefuse',
}

export const groupShareSchema = z.object({
  groupId: z.string(),
  permissions: z.array(z.enum(Permission)),
});

export interface IGroupShare {
  groupId: string;
  permissions: Permission[];
}

export const userShareSchema = z.object({
  userId: z.string(),
  permissions: z.array(z.enum(Permission)),
  /** The project ID if the user is shared from a project */
  projectId: z.string().optional(),
  extraData: z
    .object({
      // Bike4Mind-specific fields
      /** The last time the user exported data */
      lastExportDate: z.date().optional(),
    })
    .optional(),
  /**
   * TODO: To be replaced with proper user zod schema
   */
  user: z.any().optional(),
});

export interface IUserShare {
  userId: string;
  permissions: Permission[];
  /** The project ID if the user is shared from a project */
  projectId?: string;
  /**
   * The session ID if the grant was propagated from that session's knowledgeIds.
   *
   * Same role projectId plays, for the other entity that derives grants. Without it a
   * session-propagated file grant is untagged, so it merges into any direct share of the same file
   * to the same user, and revoking the session then deletes the merged row whole - destroying a
   * third party's grant the revoker was never authorized to touch.
   */
  sessionId?: string;
  extraData?: {
    // Bike4Mind-specific fields
    /** The last time the user exported data */
    lastExportDate?: Date;
  };

  /** This is a virtual field which can be lazy-loaded if needed */
  user?: IUserDocument;
}

export const shareableDocumentSchema = z.object({
  isGlobalRead: z.boolean(),
  isGlobalWrite: z.boolean(),
  users: z.array(userShareSchema),
  groups: z.array(groupShareSchema),
});

export interface IShareableDocument extends IMongoDocument {
  isGlobalRead: boolean;
  isGlobalWrite: boolean;
  users: IUserShare[];
  groups: IGroupShare[];
}

export type ShareableEntity = IShareableDocument & {
  name?: string; // Common in most entities, used for display
};

export interface IShareableStaticMethods<DocType> {
  /**
   * Find all accessible documents
   *
   * @param user - The user doc
   * @returns shared items
   */
  findAllAccessible: (user: IUserDocument) => Promise<DocType[]>;
  /**
   * Find all shared documents
   *
   * @param user - The user doc
   * @returns shared items
   */
  findAllShared: (user: IUserDocument) => Promise<DocType[]>;
  /**
   * Find a accessible document by ID
   *
   * @param user - The user doc
   * @param id - The document ID
   * @returns The shared doc
   */
  findAccessibleById: (user: IUserDocument, id: string) => Promise<DocType | null>;

  /**
   * Find all accessible documents by IDs
   *
   * @param user - The user doc
   * @param ids - The document IDs
   * @returns The documents
   */
  findAllAccessibleByIds: (user: Pick<IUserDocument, 'id' | 'groups'>, ids: string[]) => Promise<DocType[]>;

  /**
   * Find a document with update access by ID
   *
   * @param user - The user doc
   * @param id - The document ID
   * @returns The document
   */
  findUpdateAccessById: (
    user: IUserDocument,
    id: string,
    opts?: { includeGlobalWrite?: boolean }
  ) => Promise<DocType | null>;

  /**
   * Find all documents with update access by IDs
   *
   * @param user - The user doc
   * @param ids - The document IDs
   * @returns The documents
   */
  findAllUpdateAccessByIds: (user: IUserDocument, ids: string[]) => Promise<DocType[]>;

  /**
   * Find a document with share access by ID
   *
   * @param user - The user doc
   * @param id - The document ID
   * @returns The document
   */
  findShareAccessById: (user: IUserDocument, id: string) => Promise<DocType | null>;
}
