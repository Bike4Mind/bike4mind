import { IFabFileRepository, IProjectRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { revokeFromProject } from '../sharingService';

const deleteProjectSchema = z.object({
  id: z.string(),
});

type DeleteProjectParameters = z.infer<typeof deleteProjectSchema>;

interface DeleteProjectAdapters {
  db: {
    projects: IProjectRepository;
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    users: IUserRepository;
  };
}

export const deleteProject = async (
  userId: string,
  parameters: DeleteProjectParameters,
  adapters: DeleteProjectAdapters
) => {
  const { db } = adapters;
  const { id } = secureParameters(parameters, deleteProjectSchema);

  const project = await db.projects.findByIdAndUserId(id, userId);

  if (!project) {
    throw new NotFoundError('Project not found');
  }

  // Every member's file/session access is a projectId-scoped grant (see pushShareable in
  // sharingService/accept.ts); once the project is gone that grant must go too, or a former
  // member keeps reading the owner's notebooks and files. Reuses the same per-member cascade
  // leaveProject.ts uses, just for every member instead of one.
  // Best-effort and deliberately non-fatal: this runs before deletedAt is set and is not
  // transactional, so letting one member's cascade throw would abort the loop and leave the
  // project undeletable on every retry, with earlier members' file writes already persisted.
  // A member the cascade cannot resolve is a member with nothing left to revoke.
  for (const member of project.users) {
    try {
      await revokeFromProject({ project, userIdToRevoke: member.userId }, adapters);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  // The owner is never in project.users (create.ts seeds it empty), but addFiles/addSessions mint
  // the owner a projectId-scoped read+update grant on every file and session a MEMBER contributes.
  // Those have to go too, or the owner keeps reading member content after deleting the only surface
  // that could revoke it. Runs last: revokeFromProject prunes fileIds/sessionIds for documents the
  // target owns, so an earlier owner pass would hide those from the member passes above.
  try {
    await revokeFromProject({ project, userIdToRevoke: project.userId }, adapters);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }

  project.deletedAt = new Date();
  project.name = `[Deleted] ${project.id}`;

  await db.projects.update(project);

  return project;
};
