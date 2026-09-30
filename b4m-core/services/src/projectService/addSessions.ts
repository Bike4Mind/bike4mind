import {
  IFabFileDocument,
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
  Permission,
  ShareableAccessShape,
  BadRequestError,
  NotFoundError,
  secureParameters,
} from '@bike4mind/common';
import { z } from 'zod';
import { pushShareable } from '../sharingService';
import { distinctIdCount, mergeIds } from '../utils/objectIds';
import { grantCap, updateShareableFiles } from './addFiles';

const addSessionsProjectSchema = z.object({
  projectId: z.string().nonempty(),
  sessionIds: z.tuple([z.string()], z.string()),
});

type AddSessionsProjectParameters = z.infer<typeof addSessionsProjectSchema>;

interface AddSessionsProjectAdapters {
  db: {
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

export const addSessions = async (
  user: IUserDocument,
  params: AddSessionsProjectParameters,
  adapters: AddSessionsProjectAdapters
) => {
  const { db } = adapters;
  const { projectId, sessionIds } = secureParameters(params, addSessionsProjectSchema);

  // Update-level, not read-level: adding sessions mutates the project and pushes share grants
  // onto the attached sessions/files, so a read grant must not reach it. Normalized to a plain
  // object because this predicate returns a hydrated document where findAccessibleById did not.
  // Resolved before the session guards so a bad projectId answers 404 'Project not found' rather
  // than reporting the sessions as inaccessible.
  const found = await db.projects.shareable.findUpdateAccessById(user, projectId);
  // NotFoundError, not a bare Error: this refusal is routine and user-triggerable - a read-only
  // sharee clicking the button reaches it - and a bare Error is a 500 that pages LiveOps. 404
  // rather than 403 for the same reason every other door in this service answers 404: it does not
  // tell a caller whether a project they cannot reach exists.
  if (!found) {
    throw new NotFoundError('Project not found');
  }

  const project = (
    typeof (found as { toJSON?: unknown }).toJSON === 'function'
      ? (found as unknown as { toJSON: () => IProjectDocument }).toJSON()
      : found
  ) as IProjectDocument;

  // Sessions/files being added stay read-level: adding a notebook you can only read into a
  // project you can update is legitimate, same call addFiles.ts makes for fileIds.
  const sessions = await db.sessions.shareable.findAllAccessibleByIds(user, sessionIds);
  if (sessions.length === 0) {
    throw new NotFoundError('Sessions not found');
  }
  // Partial resolve is a 400; all-missing keeps the 404 above. See addFiles. Counted as DISTINCT
  // rows ignoring hex case: the reader returns one row per document, so the same notebook sent
  // twice - or sent as both `abc` and `ABC` - is not one that could not be reached.
  if (sessions.length !== distinctIdCount(sessionIds)) throw new BadRequestError('Some sessions are not accessible');

  // The ids that RESOLVED, not the request's raw list - same reason as the fileIds push below.
  project.sessionIds = mergeIds(
    project.sessionIds,
    sessions.map(session => session.id)
  );
  project.updatedAt = new Date();

  // Knowledge files are resolved (read-only) before the project write so their ids can go into it;
  // grants are pushed only after that write succeeds - see addFiles.
  const knowledge = await resolveKnowledgeFiles(user, sessions, adapters);
  project.fileIds = mergeIds(
    project.fileIds,
    knowledge.flatMap(({ files }) => files.map(file => file.id))
  );

  const written = await db.projects.updateWithUpdateAccess(user, {
    id: project.id,
    sessionIds: project.sessionIds,
    fileIds: project.fileIds,
    updatedAt: project.updatedAt,
  });
  if (!written) throw new NotFoundError('Project not found');

  await updateShareableSessions(user, { project, knowledge }, adapters);

  return sessions;
};

const resolveKnowledgeFiles = async (
  user: IUserDocument,
  sessions: ISessionDocument[],
  adapters: AddSessionsProjectAdapters
) => {
  const { db } = adapters;
  const knowledge: { session: ISessionDocument; files: IFabFileDocument[] }[] = [];
  for (const session of sessions) {
    // Access-scoped, the same call addFiles makes: `knowledgeIds` historically took client ids
    // unvalidated, and updateShareableFiles grants the project's members access on every file it
    // is handed, so an unscoped lookup would share out a file the caller cannot read. Only the
    // ids that RESOLVE reach project.fileIds, so a legacy unusable id is not copied into it and
    // spread to another document. Note this is narrower than "the castable ids": softDeletePlugin
    // adds `deletedAt: null` to the find, so a soft-deleted row is absent too and its id stops
    // being inherited. Pinned in addSessions.fileIds.test.ts.
    const files =
      session.knowledgeIds && session.knowledgeIds.length > 0
        ? await db.fabFiles.shareable.findAllAccessibleByIds(user, session.knowledgeIds)
        : [];
    knowledge.push({ session, files });
  }
  return knowledge;
};

const updateShareableSessions = async (
  user: IUserDocument,
  params: { project: IProjectDocument; knowledge: { session: ISessionDocument; files: IFabFileDocument[] }[] },
  adapters: AddSessionsProjectAdapters
) => {
  const { project, knowledge } = params;
  const { db } = adapters;

  for (const { session, files } of knowledge) {
    const cap = grantCap(session as ShareableAccessShape, user);
    const push = (userId: string, permissions: Permission[]) => {
      const capped = cap(permissions);
      if (capped.length > 0) pushShareable(session, { userId, permissions: capped, projectId: project.id });
    };

    if (project.userId !== user.id) push(project.userId, [Permission.read, Permission.update]);

    for (const member of project.users) push(member.userId, member.permissions);

    await db.sessions.update(session);

    if (files.length > 0) await updateShareableFiles(user, { project, files }, adapters);
  }
};
