import {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionRepository,
  IUserDocument,
} from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { distinctIdCount } from '../utils/objectIds';

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  sessionIds: z.array(z.string()).optional(),
  fileIds: z.array(z.string()).optional(),
});

type CreateProjectParameters = z.infer<typeof createProjectSchema>;

interface CreateProjectAdapters {
  db: {
    projects: Pick<IProjectRepository, 'create'>;
    fabFiles: Pick<IFabFileRepository, 'shareable'>;
    sessions: Pick<ISessionRepository, 'shareable'>;
  };
}

// Takes the actor rather than a bare id so the shareable predicates can match the groups[] arm
// too; an id alone would silently deny a file the caller reaches only through a group.
export const createProject = async (
  actor: Pick<IUserDocument, 'id' | 'groups'>,
  params: CreateProjectParameters,
  adapters: CreateProjectAdapters
) => {
  const { db } = adapters;
  const { name, description, sessionIds, fileIds } = secureParameters(params, createProjectSchema);
  const userId = actor.id;

  // Resolved through the caller's access predicate before persisting, same shape as addFiles.ts:
  // an unchecked id here would let project file listing, invite acceptance, and the embed-KB
  // tools expose and share-grant another user's file the moment the project is created.
  let resolvedFileIds: string[] = [];
  if (fileIds && fileIds.length > 0) {
    const files = await db.fabFiles.shareable.findAllAccessibleByIds(actor as IUserDocument, fileIds);
    if (files.length !== distinctIdCount(fileIds)) throw new BadRequestError('Some files are not accessible');
    resolvedFileIds = files.map(file => file.id);
  }

  let resolvedSessionIds: string[] = [];
  if (sessionIds && sessionIds.length > 0) {
    const sessions = await db.sessions.shareable.findAllAccessibleByIds(actor as IUserDocument, sessionIds);
    if (sessions.length !== distinctIdCount(sessionIds)) throw new BadRequestError('Some sessions are not accessible');
    resolvedSessionIds = sessions.map(session => session.id);
  }

  const buildProject: Omit<IProjectDocument, 'id'> = {
    name,
    description,
    userId,

    sessionIds: resolvedSessionIds,
    fileIds: resolvedFileIds,
    systemPrompts: [],

    isGlobalRead: false,
    isGlobalWrite: false,
    users: [],
    groups: [],

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const project = await db.projects.create(buildProject);

  return project;
};
