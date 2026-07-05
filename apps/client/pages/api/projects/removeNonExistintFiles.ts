import { baseApi } from '@server/middlewares/baseApi';
import { fabFileRepository, projectRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { ProjectEvents, IProjectDocument } from '@bike4mind/common';
import { z } from 'zod';

const RequestSchema = z.object({
  fileIds: z.array(z.string()),
});

/**
 * Removes references to no-longer-existent files from the current user's projects
 * (and revokes project users' access to those files). If fileIds are provided, only
 * projects containing them are processed.
 */
const handler = baseApi().delete(async (req, res) => {
  const userId = req.user.id;

  const { fileIds } = RequestSchema.parse(req.body);

  const filter: Record<string, any> = { userId };

  if (fileIds && fileIds.length > 0) {
    filter.fileIds = { $in: fileIds };
  }

  const projects = await projectRepository.find(filter);
  const results: IProjectDocument[] = [];

  for (const project of projects) {
    try {
      const updatedProject = await projectService.removeNonExistentFiles(
        userId,
        {
          projectId: project.id,
        },
        {
          db: {
            projects: projectRepository,
            fabFiles: fabFileRepository,
            users: userRepository,
          },
        }
      );

      await logEvent(
        {
          userId,
          type: ProjectEvents.UPDATE_PROJECT,
          metadata: {
            projectId: project.id,
            projectName: project.name,
            updatedFields: ['fileIds'],
          },
        },
        { ability: req.ability }
      );

      results.push(updatedProject);
    } catch (error) {
      console.error('Error processing project %s: %s', project.id, error);
      // don't let one failing project abort the batch
    }
  }

  return res.status(200).json({
    updatedProjects: results,
  });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
