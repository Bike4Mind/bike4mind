import { IBaseRepository } from './BaseTypes';
import { IShareableDocument, IShareableStaticMethods } from './ShareableDocumentTypes';
import type { IUserDocument } from './UserTypes';

export interface IProjectMethods {}

export interface IProjectRepository extends IBaseRepository<IProjectDocument> {
  shareable: IShareableStaticMethods<IProjectDocument>;
  /**
   * Partial update that re-checks update access and not-deleted in the write filter; null when the
   * project is gone, deleted, or no longer writable by `user`.
   */
  updateWithUpdateAccess: (
    user: Pick<IUserDocument, 'id' | 'groups'>,
    data: Partial<IProjectDocument> & { id: string }
  ) => Promise<IProjectDocument | null>;
  /**
   * Find a project by ID and user ID
   *
   * @param id - The project ID
   * @param userId - The user ID
   * @returns The project
   */
  findByIdAndUserId: (id: string, userId: string) => Promise<IProjectDocument | null>;
  /**
   * Search for accessible projects
   *
   * @param userId - The user ID
   * @param search - The search query
   * @param filters - The filters
   * @param pagination - The pagination
   * @param orderBy - The order by
   * @returns The projects
   */
  searchAccessible: (
    userId: string,
    search: string,
    filters: { favorite?: boolean; query?: Record<string, unknown> },
    pagination: { page: number; limit: number },
    orderBy: { by: 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' }
  ) => Promise<{ data: IProject[]; hasMore: boolean; total: number }>;

  /**
   * One keyset page of readable projects in ascending `_id` order, starting after `afterId`. Same
   * reach as `shareable.findAccessibleById` (owner, user or group read/write share; no global
   * read), so every id it returns resolves by id. Returns at most `limit + 1` documents.
   */
  listAccessibleAfterId: (
    user: Pick<IUserDocument, 'id' | 'groups'>,
    options: { afterId?: string; limit: number }
  ) => Promise<{ data: IProject[]; hasMore: boolean }>;

  removeSession: (sessionId: string) => Promise<void>;

  /**
   * Remove the given file ids from `fileIds` and `systemPrompts` (idempotent $pull), in one project
   * (`projectId`) or in every live project owned by or directly shared with any of `userIds`. Both
   * forms are bounded by an index (`_id`; `userId`+`name` and `users.userId`) - there is
   * deliberately no unscoped form, since neither file-id field is indexed.
   */
  pullFileReferences: (fileIds: string[], scope: { projectId: string } | { userIds: string[] }) => Promise<void>;

  /**
   * Find all projects by session ID
   *
   * @param sessionId - The session ID
   * @returns The projects
   */
  findAllBySessionId: (sessionId: string) => Promise<IProjectDocument[]>;
}

export interface ISystemPrompt {
  fileId: string;
  enabled: boolean;
}

export interface IProject {
  id: string;
  name: string;
  description: string;
  userId: string;

  sessionIds: string[];
  fileIds: string[];

  systemPrompts: ISystemPrompt[];

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export interface IProjectDocument extends IProject, IShareableDocument {}
