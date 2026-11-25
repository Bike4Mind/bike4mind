import {
  IFabFileDocument,
  IFabFileRepository,
  IInviteRepository,
  IUserRepository,
  InviteType,
  UserShareGrant,
} from '@bike4mind/common';

export interface RevokeProjectFileGrantsAdapters {
  db: {
    fabFiles: IFabFileRepository;
    users: Pick<IUserRepository, 'findByIds'>;
    invites: Pick<IInviteRepository, 'findAllByDocumentId'>;
  };
}

/**
 * Drops the grants `projectId` pushed onto each file when it was attached. Shared by removeFiles and
 * removeSystemPrompts, which must revoke identically. `softDeletedIds` are files hidden from normal
 * reads that still hold project-tagged grants a restore would bring back.
 */
export const revokeProjectFileGrants = async (
  projectId: string,
  params: { files: IFabFileDocument[]; softDeletedIds?: string[] },
  adapters: RevokeProjectFileGrantsAdapters
) => {
  const { files, softDeletedIds = [] } = params;
  const { db } = adapters;

  // Revoke project-derived access to the file, but keep an entry that ALSO has an
  // independently-accepted direct invite to the same file (only clearing its projectId) -
  // IUserShare tracks one projectId, so a user who both is a project member and separately
  // accepted a direct share for this file cannot otherwise be told apart from one whose only
  // access came from the project, and would lose the direct share too.
  for (const file of files) {
    const projectMemberEntries = file.users.filter(u => u.projectId === projectId);
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

    const directGrants: UserShareGrant[] = [];
    for (const entry of projectMemberEntries) {
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
        directGrants.push({ userId: entry.userId, permissions: directGrantPermissions });
      }
      // else: access came solely from this project - drop the entry entirely.
    }
    await db.fabFiles.shareable.updateUserShares(file.id, { remove: { projectId }, add: directGrants });
  }

  for (const id of softDeletedIds) {
    await db.fabFiles.shareable.updateUserShares(id, { remove: { projectId }, add: [], includeDeleted: true });
  }
};
