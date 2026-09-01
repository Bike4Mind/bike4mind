import {
  IFabFileDocument,
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  IUserDocument,
  Permission,
  secureParameters,
  BadRequestError,
} from '@bike4mind/common';
import { z } from 'zod';
import uniq from 'lodash/uniq.js';
import { pushShareable } from '../sharingService';
import { distinctIdCount } from '../utils/objectIds';

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

  // BadRequestError, not a bare Error: an id the caller cannot reach is a client mistake, and a
  // bare Error is a 500 that pages LiveOps. Reachable now that the repository skips uncastable
  // ids instead of throwing a CastError the handler turned into a 404. Compared against the
  // DEDUPED list, since the reader returns distinct rows and a file sent twice is not one that
  // could not be reached.
  if (files.length !== distinctIdCount(fileIds)) throw new BadRequestError('Some files are not accessible');

  // The ids that RESOLVED, like addSessions: pushing the request list would store `ABC` alongside
  // an existing `abc` as if they were two different files.
  project.fileIds = uniq([...project.fileIds, ...files.map(f => f.id)]);
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
