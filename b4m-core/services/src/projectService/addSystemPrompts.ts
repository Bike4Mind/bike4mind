import { Logger } from '@bike4mind/observability';
import { pushShareable } from '../sharingService';
import { IFabFileRepository, IProjectRepository, IUserDocument, Permission } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const addSystemPromptsSchema = z.object({
  projectId: z.string(),
  fileIds: z.array(z.string()),
});

type AddSystemPromptsParameters = z.infer<typeof addSystemPromptsSchema>;

interface AddSystemPromptsAdapters {
  db: {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

export const addSystemPrompts = async (
  user: IUserDocument,
  params: AddSystemPromptsParameters,
  adapters: AddSystemPromptsAdapters
) => {
  const { db } = adapters;
  const { projectId, fileIds } = secureParameters(params, addSystemPromptsSchema);

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const files = await db.fabFiles.shareable.findAllAccessibleByIds(user, fileIds);
  if (files.length !== fileIds.length) throw new BadRequestError('Some files are not accessible');

  // Filter out files that are already system prompts
  const newFileIds = fileIds.filter(fileId => !project.systemPrompts.some(prompt => prompt.fileId === fileId));

  if (newFileIds.length === 0) {
    throw new BadRequestError('All files are already added as system prompts');
  }

  const newSystemPrompts = newFileIds.map(fileId => ({
    fileId,
    enabled: true,
  }));

  project.systemPrompts.push(...newSystemPrompts);
  project.updatedAt = new Date();

  try {
    const fileUpdates = [];
    for (const file of files) {
      // Share with project owner if they're not the one adding the file
      if (project.userId !== user.id) {
        pushShareable(file, {
          userId: project.userId,
          permissions: [Permission.read, Permission.update],
          projectId,
        });
      }

      // Share with all project members
      for (const projectUser of project.users) {
        pushShareable(file, { userId: projectUser.userId, permissions: projectUser.permissions, projectId });
      }

      fileUpdates.push(db.fabFiles.update(file));
    }

    await Promise.all([...fileUpdates, db.projects.update(project)]);

    return project;
  } catch (error) {
    // Cleanup on error - remove added system prompts
    project.systemPrompts = project.systemPrompts.filter(prompt => !newFileIds.includes(prompt.fileId));

    try {
      await db.projects.update(project);
    } catch (cleanupError) {
      Logger.globalInstance.error('Failed to cleanup after error:', cleanupError);
    }

    throw error;
  }
};
