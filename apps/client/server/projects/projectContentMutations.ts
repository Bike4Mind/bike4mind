import {
  activityRepository,
  fabFileRepository,
  inviteRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import { ProjectEvents } from '@bike4mind/common';
import { projectService } from '@bike4mind/services';
import { ActivityType } from '@bike4mind/server-utils/config/activityType';
import { logEvent } from '@server/utils/analyticsLog';
import type { ProjectMutationContext } from './attachSessionsToProject';

/**
 * The file/session add and remove writes behind POST/DELETE /api/projects/[id]/(files|sessions) and
 * their /api/v1/projects twins. Each runs the service write in a transaction, then emits the same
 * analytics events, so the two surfaces cannot drift. Attaching sessions lives in
 * attachSessionsToProject because it also fans out summaries.
 */

export async function addFilesToProject(
  ctx: ProjectMutationContext & { user: IUserDocument },
  projectId: string,
  fileIds: [string, ...string[]]
) {
  const project = await withTransaction(() =>
    projectService.addFiles(
      ctx.user,
      {
        projectId,
        fileIds,
      },
      {
        db: {
          fabFiles: fabFileRepository,
          projects: projectRepository,
        },
      }
    )
  );

  await Promise.all(
    fileIds.map((fileId: string) =>
      logEvent(
        {
          userId: ctx.user.id,
          type: ProjectEvents.ADD_FILE,
          metadata: {
            projectId: project.id,
            projectName: project.name,
            contentId: fileId,
            contentType: 'file',
          },
        },
        { ability: ctx.ability }
      )
    )
  );

  return project;
}

export async function removeFilesFromProject(ctx: ProjectMutationContext, projectId: string, fileIds: string[]) {
  const { project, removedIds } = await withTransaction(() =>
    projectService.removeFiles(
      ctx.user.id,
      {
        projectId,
        fileIds,
      },
      {
        db: {
          fabFiles: fabFileRepository,
          projects: projectRepository,
          users: userRepository,
          invites: inviteRepository,
        },
      }
    )
  );

  await Promise.all(
    removedIds.map((fileId: string) =>
      logEvent(
        {
          userId: ctx.user.id,
          type: ProjectEvents.REMOVE_FILE,
          metadata: {
            projectId: project.id,
            projectName: project.name,
            contentId: fileId,
            contentType: 'file',
          },
        },
        { ability: ctx.ability }
      )
    )
  );

  return project;
}

export async function removeSessionsFromProject(ctx: ProjectMutationContext, projectId: string, sessionIds: string[]) {
  const { project, removedIds } = await withTransaction(() =>
    projectService.removeSessions(
      ctx.user.id,
      {
        projectId,
        sessionIds,
      },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          users: userRepository,
        },
      }
    )
  );

  // A retried or no-op removal (v1 DELETE answers 204 for it) must not log a removal that did not happen.
  if (removedIds.length > 0) {
    await activityRepository.createActivity(
      ActivityType.NOTEBOOK_REMOVED_FROM_PROJECT,
      { type: 'Project', id: projectId },
      { type: 'User', id: ctx.user.id }
    );
  }

  await Promise.all(
    removedIds.map((sessionId: string) =>
      logEvent(
        {
          userId: ctx.user.id,
          type: ProjectEvents.REMOVE_SESSION,
          metadata: {
            projectId: project.id,
            projectName: project.name,
            contentId: sessionId,
            contentType: 'session',
          },
        },
        { ability: ctx.ability }
      )
    )
  );

  return project;
}
