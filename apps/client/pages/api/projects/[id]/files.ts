import { z } from 'zod';
import { projectRepository, fabFileRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  assertProjectsReadScope,
  assertProjectsWriteScope,
  PROJECTS_READ_OR_WRITE_SCOPES,
} from '@server/projects/projectScopes';
import { addFilesToProject, removeFilesFromProject } from '@server/projects/projectContentMutations';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';

const addFileIdsBodySchema = z.object({
  fileIds: z.array(z.string()).min(1),
});

const removeFileIdsBodySchema = z.object({
  fileIds: z.array(z.string()),
});

// baseApi's scope gate is per route, so it admits either projects scope and each method asserts its own.
const handler = baseApi({ requiredScopes: PROJECTS_READ_OR_WRITE_SCOPES })
  .get(
    asyncHandler<{ id: string }>(async (req, res) => {
      assertProjectsReadScope(req);
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
      assertProjectsWriteScope(req);
      const { id } = req.query as { id: string };
      const { fileIds } = addFileIdsBodySchema.parse(req.body);

      const project = await addFilesToProject(
        { user: req.user, ability: req.ability, logger: req.logger },
        id,
        fileIds as [string, ...string[]]
      );

      return res.json(project);
    })
  )
  .delete(
    asyncHandler<{ id: string }>(async (req, res) => {
      assertProjectsWriteScope(req);
      const { id } = req.query as { id: string };
      const { fileIds } = removeFileIdsBodySchema.parse(req.body);

      const project = await removeFilesFromProject(
        { user: req.user, ability: req.ability, logger: req.logger },
        id,
        fileIds
      );

      return res.json(project);
    })
  );

export default handler;
