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
    const directInvites = projectMemberEntries.length
      ? (await db.invites.findAllByDocumentId(file.id)).filter(invite => invite.type === InviteType.FabFile)
      : [];

    // Batched, not one findById per entry: this loop runs inside the route's transaction, so
    // an unmemoized per-entry lookup would hold it open for one round trip per project member.
    const granteeEmailsById = new Map<string, string>();
    if (directInvites.length) {
      for (const grantee of await db.users.findByIds(projectMemberEntries.map(u => u.userId))) {
        if (grantee.email) granteeEmailsById.set(grantee.id, grantee.email);
      }
    }

    const nextUsers: typeof file.users = [];
    for (const entry of file.users) {
      if (entry.projectId !== project.id) {
        nextUsers.push(entry);
        continue;
      }
      const email = granteeEmailsById.get(entry.userId);
      const directGrantPermissions = email
        ? Array.from(
            new Set(
              directInvites
                .filter(invite => invite.recipients?.accepted?.includes(email))
                .flatMap(invite => ('permissions' in invite ? invite.permissions : []))
            )
          )
        : [];
      if (directGrantPermissions.length) {
        // Keep only what the independent direct invite itself grants, not the full
        // permission union pushShareable may have merged in from the project side -
        // otherwise a permission that came SOLELY from project membership (e.g. update,
        // when the direct invite only ever granted read+share) would outlive this revoke.
        nextUsers.push({ ...entry, projectId: undefined, permissions: directGrantPermissions });
      }
      // else: access came solely from this project - drop the entry entirely.
    }
    file.users = nextUsers;
    await db.fabFiles.update(file);
  }

  await db.projects.update(project);

  return project;
};
