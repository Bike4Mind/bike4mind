import { fabFileRepository, projectRepository, withTransaction } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().post(
  asyncHandler<{ id: string }>(async (req, res) => {
    const { id } = req.query as { id: string };
    const { fileId } = req.body as { fileId: string };

    const project = await withTransaction(() =>
      projectService.toggleSystemPrompt(
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

    return res.json(project);
  })
);

export default handler;
