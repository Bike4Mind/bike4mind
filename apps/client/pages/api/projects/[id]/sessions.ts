import {
  activityRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { ProjectEvents, redactSessionsForClient } from '@bike4mind/common';
import { ActivityType } from '@client/config/activities';
import { ProjectSessionsRequestBody } from '../../../../types/api';
import { SessionEvents } from '@server/utils/eventBus';

const handler = baseApi()
  .get(
    asyncHandler<{ id: string }>(async (req, res) => {
      const { id } = req.query as { id: string };
      const sessions = await projectService.listSessions(
        req.user.id,
        {
          projectId: id,
        },
        {
          db: {
            sessions: sessionRepository,
            projects: projectRepository,
            users: userRepository,
          },
        }
      );
      return res.json(redactSessionsForClient(sessions));
    })
  )
  .post(
    asyncHandler<{ id: string }>(async (req, res) => {
      const { id } = req.query as { id: string };
      const { sessionIds } = req.body as ProjectSessionsRequestBody;

      const project = await projectService.get(
        req.user.id,
        { id },
        {
          db: {
            projects: projectRepository,
            users: userRepository,
          },
        }
      );

      const sessions = await withTransaction(async () => {
        const user = await userRepository.findById(req.user.id);
        if (!user) {
          throw new Error('User not found');
        }
        return projectService.addSessions(
          user,
          {
            projectId: id,
            sessionIds: sessionIds as [string, ...string[]],
          },
          {
            db: {
              sessions: sessionRepository,
              projects: projectRepository,
              fabFiles: fabFileRepository,
            },
          }
        );
      });

      await Promise.allSettled(
        sessionIds.map(async (sessionId: string) => {
          logEvent(
            {
              userId: req.user.id,
              type: ProjectEvents.ADD_SESSION,
              metadata: {
                projectId: id,
                projectName: project.name,
                contentId: sessionId,
                contentType: 'session',
              },
            },
            { ability: req.ability }
          );
          await SessionEvents.Summarize.publish({ sessionId: sessionId, callTagging: true, trigger: 'project' });
        })
      );

      return res.json(redactSessionsForClient(sessions));
    })
  )
  .delete(
    asyncHandler<{ id: string }>(async (req, res) => {
      const { id } = req.query as { id: string };
      const { sessionIds } = req.body as ProjectSessionsRequestBody;

      const project = await withTransaction(() =>
        projectService.removeSessions(
          req.user.id,
          {
            projectId: id,
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

      await activityRepository.createActivity(
        ActivityType.NOTEBOOK_REMOVED_FROM_PROJECT,
        { type: 'Project', id },
        { type: 'User', id: req.user.id }
      );

      await Promise.all(
        sessionIds.map((sessionId: string) =>
          logEvent(
            {
              userId: req.user.id,
              type: ProjectEvents.REMOVE_SESSION,
              metadata: {
                projectId: project.id,
                projectName: project.name,
                contentId: sessionId,
                contentType: 'session',
              },
            },
            { ability: req.ability }
          )
        )
      );

      return res.json(project);
    })
  );

export default handler;
