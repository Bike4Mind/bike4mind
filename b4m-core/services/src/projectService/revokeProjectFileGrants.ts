import { IFabFileDocument, IFabFileRepository } from '@bike4mind/common';

export interface RevokeProjectFileGrantsAdapters {
  db: {
    fabFiles: IFabFileRepository;
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

  // Only the rows this project minted. A direct share is its own untagged row and survives untouched.
  for (const file of files) {
    await db.fabFiles.shareable.updateUserShares(file.id, { remove: { projectId } });
  }

  for (const id of softDeletedIds) {
    await db.fabFiles.shareable.updateUserShares(id, { remove: { projectId }, add: [], includeDeleted: true });
  }
};
