import { withTransaction, projectRepository, fabFileRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { ProjectEvents } from '@bike4mind/common';
import { getFilesStorage } from '@server/utils/storage';

const handler = baseApi()
  .get(
    asyncHandler<{ id: string }>(async (req, res) => {
      const { id } = req.query as { id: string };
      const files = await projectService.listFiles(
        req.user.id,
        {
          projectId: id,
        },
        {
          db: {
            projects: projectRepository,
            files: fabFileRepository,
            users: userRepository,
          },
          storage: getFilesStorage(),
        }
      );

      return res.json(files);
    })
  )
  .post(
    asyncHandler<{ id: string }>(async (req, res) => {
      const { id } = req.query as { id: string };
      const { fileIds } = req.body as any;

      const project = await withTransaction(() =>
        projectService.addFiles(
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
              type: ProjectEvents.ADD_FILE,
              metadata: {
                projectId: project.id,
                projectName: project.name,
                contentId: fileId,
                contentType: 'file',
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
      const { fileIds } = req.body as any;

      const project = await withTransaction(() =>
        projectService.removeFiles(
          req.user.id,
          {
            projectId: id,
            fileIds,
          },
          {
            db: {
              fabFiles: fabFileRepository,
              projects: projectRepository,
              users: userRepository,
            },
          }
        )
      );

      await Promise.all(
        fileIds.map((fileId: string) =>
          logEvent(
            {
              userId: req.user.id,
              type: ProjectEvents.REMOVE_FILE,
              metadata: {
                projectId: project.id,
                projectName: project.name,
                contentId: fileId,
                contentType: 'file',
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
