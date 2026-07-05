import { IFabFileRepository, IProjectRepository, IUserRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const removeProjectFilesSchema = z.object({
  projectId: z.string(),
  fileIds: z.array(z.string()),
});

type RemoveProjectFilesParameters = z.infer<typeof removeProjectFilesSchema>;

interface RemoveProjectFilesAdapters {
  db: {
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
    users: IUserRepository;
  };
}

export const removeFiles = async (
  userId: string,
  params: RemoveProjectFilesParameters,
  adapters: RemoveProjectFilesAdapters
) => {
  const { db } = adapters;
  const { projectId, fileIds } = secureParameters(params, removeProjectFilesSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new Error('User not found');

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const files = await db.fabFiles.shareable.findAllAccessibleByIds(user, fileIds);

  if (files.length !== fileIds.length) throw new Error('Some files are not accessible');

  if (project.userId !== userId && files.some(f => f.userId !== userId)) {
    throw new Error('You are not authorized to remove files from this project');
  }

  project.fileIds = project.fileIds.filter(id => !fileIds.includes(id));
  project.updatedAt = new Date();

  // Revoke all project users access to the file
  for (const file of files) {
    file.users = file.users.filter(u => u.projectId !== project.id);
    await db.fabFiles.update(file);
  }

  await db.projects.update(project);

  return project;
};
