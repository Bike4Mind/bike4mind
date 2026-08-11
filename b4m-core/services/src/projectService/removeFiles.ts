import {
  IFabFileRepository,
  InviteType,
  IInviteRepository,
  IProjectRepository,
  IUserRepository,
} from '@bike4mind/common';
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
    invites: Pick<IInviteRepository, 'findAllByDocumentId'>;
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

  // Revoke project-derived access to the file, but keep an entry that ALSO has an
  // independently-accepted direct invite to the same file (only clearing its projectId) -
  // IUserShare tracks one projectId, so a user who both is a project member and separately
  // accepted a direct share for this file cannot otherwise be told apart from one whose only
  // access came from the project, and would lose the direct share too.
  for (const file of files) {
    const projectMemberEntries = file.users.filter(u => u.projectId === project.id);
    const directlySharedEmails = projectMemberEntries.length
      ? new Set(
          (await db.invites.findAllByDocumentId(file.id))
            .filter(invite => invite.type === InviteType.FabFile)
            .flatMap(invite => invite.recipients?.accepted ?? [])
        )
      : new Set<string>();

    const nextUsers: typeof file.users = [];
    for (const entry of file.users) {
      if (entry.projectId !== project.id) {
        nextUsers.push(entry);
        continue;
      }
      const grantee = directlySharedEmails.size ? await db.users.findById(entry.userId) : null;
      if (grantee?.email && directlySharedEmails.has(grantee.email)) {
        nextUsers.push({ ...entry, projectId: undefined });
      }
      // else: access came solely from this project - drop the entry entirely.
    }
    file.users = nextUsers;
    await db.fabFiles.update(file);
  }

  await db.projects.update(project);

  return project;
};
