import { IFabFileRepository, IProjectRepository, IUserRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const removeNonExistentFilesSchema = z.object({
  projectId: z.string(),
});

type RemoveNonExistentFilesParameters = z.infer<typeof removeNonExistentFilesSchema>;

interface RemoveNonExistentFilesAdapters {
  db: {
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
    users: IUserRepository;
  };
}

/**
 * Removes file IDs from a project that no longer exist in the fabFiles collection
 * and removes project users' access to those files.
 *
 * @param userId - The ID of the user performing the action
 * @param params - Parameters containing the project ID
 * @param adapters - Database adapters for projects, fabFiles, and users
 * @returns The updated project
 */
export const removeNonExistentFiles = async (
  userId: string,
  params: RemoveNonExistentFilesParameters,
  adapters: RemoveNonExistentFilesAdapters
) => {
  const { db } = adapters;
  const { projectId } = secureParameters(params, removeNonExistentFilesSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new Error('User not found');

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  if (project.userId !== userId) {
    throw new Error('You are not authorized to update this project');
  }

  if (!project.fileIds || project.fileIds.length === 0) {
    return project;
  }

  // Find all existing files from the project's fileIds that haven't been soft deleted
  const existingFiles = await db.fabFiles.findAllByIds(project.fileIds);
  const existingFileIds = existingFiles.filter(file => !file.deletedAt).map(file => file.id);

  const nonExistentFileIds = project.fileIds.filter(id => !existingFileIds.includes(id));

  if (nonExistentFileIds.length === 0) {
    return project;
  }

  project.fileIds = project.fileIds.filter(id => existingFileIds.includes(id));
  project.updatedAt = new Date();

  // For each existing file, remove project users' access if the file is shared through this project
  for (const file of existingFiles) {
    const hasProjectUsers = file.users && file.users.some(u => u.projectId === project.id);

    if (hasProjectUsers) {
      file.users = file.users.filter(u => u.projectId !== project.id);
      await db.fabFiles.update(file);
    }
  }

  await db.projects.update(project);

  return project;
};
