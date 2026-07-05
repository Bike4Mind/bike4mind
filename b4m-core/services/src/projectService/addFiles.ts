import {
  IFabFileDocument,
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  IUserDocument,
  Permission,
} from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import uniq from 'lodash/uniq.js';
import { pushShareable } from '../sharingService';

const addFilesProjectSchema = z.object({
  projectId: z.string().nonempty(),
  fileIds: z.tuple([z.string()], z.string()),
});

type AddFilesProjectParameters = z.infer<typeof addFilesProjectSchema>;

interface AddFilesProjectAdapters {
  db: {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

export const addFiles = async (
  user: IUserDocument,
  params: AddFilesProjectParameters,
  adapters: AddFilesProjectAdapters
) => {
  const { db } = adapters;
  const { projectId, fileIds } = secureParameters(params, addFilesProjectSchema);
  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const files = await db.fabFiles.shareable.findAllAccessibleByIds(user, fileIds);

  if (files.length !== fileIds.length) throw new Error('Some files are not accessible');

  project.fileIds = uniq([...project.fileIds, ...fileIds]);
  project.updatedAt = new Date();

  await updateShareableFiles(user.id, { project, files }, adapters);

  await db.projects.update(project);

  return project;
};

export const updateShareableFiles = async (
  userId: string,
  params: { project: IProjectDocument; files: IFabFileDocument[] },
  adapters: { db: { fabFiles: IFabFileRepository } }
) => {
  const { project, files } = params;
  const { db } = adapters;

  for (const file of files) {
    if (project.userId !== userId) {
      pushShareable(file, {
        userId: project.userId,
        permissions: [Permission.read, Permission.update],
        projectId: project.id,
      });
    }

    for (const user of project.users) {
      pushShareable(file, { userId: user.userId, permissions: user.permissions, projectId: project.id });
    }

    await db.fabFiles.update(file);
  }
};
