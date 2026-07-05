import { sessionService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  fabFileRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  User,
  activityRepository,
} from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { SessionEvents, ProjectEvents, redactSessionForClient } from '@bike4mind/common';
import { projectService } from '@bike4mind/services';
import { ActivityType } from '@client/config/activities';
import { CreateSessionRequestBody } from '../../../types/api';

interface CreateSessionBody {
  projectId?: string;
  [key: string]: any;
}

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { projectId } = req.body as CreateSessionBody;
    const newSession = await sessionService.createSession(req.user, req.body as CreateSessionRequestBody, {
      db: {
        sessions: sessionRepository,
        projects: projectRepository,
        fabFiles: fabFileRepository,
      },
    });

    await User.findByIdAndUpdate(userId, { lastNotebookId: newSession.id });

    const asyncPromises = [];
    asyncPromises.push(
      logEvent(
        {
          userId,
          type: SessionEvents.CREATE_SESSION,
          metadata: {
            sessionId: newSession.id,
            sessionName: newSession.name,
            knowledgeIds: newSession.knowledgeIds ?? [],
            agentIds: newSession.agentIds ?? [],
          },
        },
        { ability: req.ability }
      )
    );

    if (projectId) {
      const project = await projectService.get(
        userId,
        { id: projectId },
        {
          db: {
            projects: projectRepository,
            users: userRepository,
          },
        }
      );

      asyncPromises.push(
        logEvent(
          {
            userId,
            type: ProjectEvents.ADD_SESSION,
            metadata: {
              projectId,
              projectName: project.name,
              contentId: newSession.id,
              contentType: 'session',
            },
          },
          { ability: req.ability }
        )
      );

      asyncPromises.push(
        activityRepository.createActivity(
          ActivityType.NOTEBOOK_ADDED_TO_PROJECT,
          { type: 'Project', id: projectId },
          { type: 'User', id: userId }
        )
      );
    }
    await Promise.all(asyncPromises);

    // Redact server-owned fields (e.g. systemPromptText) from the client response
    return res.json(redactSessionForClient(newSession));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
