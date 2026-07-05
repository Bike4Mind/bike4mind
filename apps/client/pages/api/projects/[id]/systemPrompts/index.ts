import { fabFileRepository, projectRepository, withTransaction } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { ProjectEvents } from '@bike4mind/common';
import { ProjectFilesRequestBody } from '../../../../../types/api';

const handler = baseApi()
  .post(
    asyncHandler<{ id: string }>(async (req, res) => {
      const { id } = req.query as { id: string };
      const { fileIds } = req.body as ProjectFilesRequestBody;

      const project = await withTransaction(() =>
        projectService.addSystemPrompts(
          req.user,
          {
            projectId: id,
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
              userId: req.user.id,
              type: ProjectEvents.ADD_SYSTEM_PROMPT,
              metadata: {
                projectId: project.id,
                projectName: project.name,
                promptId: fileId,
              },
            },
            { ability: req.ability }
          )
        )
      );

      return res.json(project);
    })
  )
  .delete(
    asyncHandler<{ id: string }>(async (req, res) => {
      const { id } = req.query as { id: string };
      const { fileId } = req.body as { fileId: string };

      const project = await withTransaction(() =>
        projectService.removeSystemPrompt(
          req.user,
          {
            projectId: id,
            fileId,
          },
          {
            db: {
              fabFiles: fabFileRepository,
              projects: projectRepository,
            },
          }
        )
      );

      await logEvent(
        {
          userId: req.user.id,
          type: ProjectEvents.REMOVE_SYSTEM_PROMPT,
          metadata: {
            projectId: project.id,
            projectName: project.name,
            promptId: fileId,
          },
        },
        { ability: req.ability }
      );

      return res.json(project);
    })
  );

export default handler;
