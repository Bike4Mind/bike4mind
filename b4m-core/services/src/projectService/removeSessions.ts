import {
  IProjectRepository,
  ISessionRepository,
  IUserRepository,
  secureParameters,
  BadRequestError,
} from '@bike4mind/common';
import { z } from 'zod';
import { canonicalId } from '../utils/objectIds';
import { usableObjectIds } from '@bike4mind/db-core';

const removeProjectSessionsSchema = z.object({
  projectId: z.string(),
  sessionIds: z.array(z.string()),
});

type RemoveProjectSessionsParameters = z.infer<typeof removeProjectSessionsSchema>;

interface RemoveProjectSessionsAdapters {
  db: {
    projects: IProjectRepository;
    sessions: ISessionRepository;
    users: IUserRepository;
  };
}

export const removeSessions = async (
  userId: string,
  params: RemoveProjectSessionsParameters,
  adapters: RemoveProjectSessionsAdapters
) => {
  const { db } = adapters;
  const { projectId, sessionIds } = secureParameters(params, removeProjectSessionsSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new Error('User not found');

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const sessions = await db.sessions.shareable.findAllAccessibleByIds(user, sessionIds);
  // BadRequestError, not a bare Error - see addFiles.
  // Asked for by id, not by count, so a duplicate cannot read as a miss. An id that cannot
  // address a row is EXCLUDED rather than rejected: it is what the caller wants gone, the read
  // guards skip it, and rejecting left it in the project permanently, warning on every read.
  // The filter below still removes it. A castable id that did not resolve is still an access
  // failure and still a 400.
  // Compared canonically - hex folded to lowercase, non-hex left exactly as stored. A hex id is
  // accepted in either case and resolves the same row, but `s.id` is always canonical lowercase,
  // so matching raw strings would reject an uppercase id that Mongo resolved perfectly well.
  // Non-hex is NOT folded: two legacy entries differing only in case are different rows.
  const resolvedIds = new Set(sessions.map(s => canonicalId(String(s.id))));
  const addressable = new Set(usableObjectIds(sessionIds, 'projectService.removeSessions').map(canonicalId));
  if (sessionIds.some(id => addressable.has(canonicalId(id)) && !resolvedIds.has(canonicalId(id)))) {
    throw new BadRequestError('Some sessions are not accessible');
  }
  if (project.userId !== userId && sessions.some(s => s.userId !== userId)) {
    throw new Error('You are not authorized to remove sessions from this project');
  }

  // Canonical on both sides here too: a stored id is lowercase, so an uppercase request id
  // would match nothing and the call would answer 200 having removed nothing at all.
  const removing = new Set(sessionIds.map(canonicalId));
  project.sessionIds = project.sessionIds.filter(id => !removing.has(canonicalId(id)));
  project.updatedAt = new Date();

  // Revoke all project users access to the session
  for (const session of sessions) {
    session.users = session.users.filter(u => u.projectId !== project.id);
    await db.sessions.update(session);
  }

  await db.projects.update(project);

  return project;
};
