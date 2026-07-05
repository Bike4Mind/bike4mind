import {
  activityRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { ProjectEvents } from '@bike4mind/common';
import { ActivityType } from '@client/config/activities';

const handler = baseApi().delete(async (req, res) => {
  const { userId: memberIdToRemove } = req.body;
  const isRemovingMember = !!memberIdToRemove;
  const projectId = req.query.id as string;

  const result = await withTransaction(async session => {
    projectRepository.txn = session;
    fabFileRepository.txn = session;

    const project = await projectService.leaveProject(
      req.user,
      {
        id: projectId,
        userIdToRemove: memberIdToRemove,
      },
      {
        db: {
          projects: projectRepository,
          sessions: sessionRepository,
          fabFiles: fabFileRepository,
          users: userRepository,
        },
      }
    );

    if (isRemovingMember) {
      await logEvent(
        {
          userId: req.user.id,
          type: ProjectEvents.REMOVE_MEMBER,
          metadata: {
            projectId,
            projectName: project.name,
            memberId: memberIdToRemove,
          },
        },
        { ability: req.ability }
      );
    } else {
      await logEvent(
        {
          userId: req.user.id,
          type: ProjectEvents.PROJECT_LEAVED,
          metadata: {
            projectId,
            projectName: project.name,
            memberId: req.user.id,
          },
        },
        { ability: req.ability }
      );

      await activityRepository.createActivity(
        ActivityType.PROJECT_LEAVED,
        { type: 'Project', id: projectId },
        { type: 'User', id: req.user.id }
      );
    }

    return project;
  });

  return res.json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
