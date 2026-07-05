import { Logger } from '@bike4mind/observability';
import {
  IFabFileChunkRepository,
  IFabFileDocument,
  IFabFileRepository,
  ISessionRepository,
  IUserRepository,
} from '@bike4mind/common';
import { secureParameters, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const deleteFabFileSchema = z.object({
  id: z.string(),
});

type DeleteFabFileParameters = z.infer<typeof deleteFabFileSchema>;

export type DeleteFabFileAction = 'deleted' | 'unshared' | 'not_found';

export interface DeleteFabFileResult {
  action: DeleteFabFileAction;
  fabFile: IFabFileDocument | null;
}

export interface DeleteFabFileAdapter {
  db: {
    fabFiles: Pick<
      IFabFileRepository,
      'findByIdAndUserId' | 'findById' | 'findAllInIds' | 'update' | 'deleteManyInIds'
    >;
    fabFileChunks: Pick<IFabFileChunkRepository, 'deleteManyByFabFileId'>;
    users: Pick<IUserRepository, 'findById' | 'update'>;
    sessions: Pick<ISessionRepository, 'findAllWithKnowledgeId' | 'update'>;
  };
  storage: {
    delete: (path: string) => Promise<unknown>;
  };
  onDeleteComplete?: (fabFile: IFabFileDocument, sizeToDeduct: number) => Promise<void>;
}

export const deleteFabFile = async (
  userId: string,
  parameters: DeleteFabFileParameters,
  adapter: DeleteFabFileAdapter
): Promise<DeleteFabFileResult> => {
  const { db, storage, onDeleteComplete } = adapter;
  const { id } = secureParameters(parameters, deleteFabFileSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new UnauthorizedError('User not found');

  // 1. Check if the user owns the file
  const ownedFile = await db.fabFiles.findByIdAndUserId(id, userId);
  if (ownedFile) {
    // User owns this file - soft-delete it
    Logger.globalInstance.log(
      `[deleteFabFile] Deleting owned file — fileId: ${ownedFile.id}, fileName: ${ownedFile.fileName}, userId: ${userId}`
    );
    await db.fabFiles.update({ id: ownedFile.id, deletedAt: new Date() });

    // Delete the main file in S3 and calculate size
    let sizeToDeduct = 0;
    const storagePathsToDelete: string[] = [];
    if (ownedFile.filePath) {
      Logger.globalInstance.log(`[deleteFabFile] Deleting S3 object — path: ${ownedFile.filePath}`);
      storagePathsToDelete.push(ownedFile.filePath);
      if (typeof ownedFile.fileSize === 'number') {
        sizeToDeduct += ownedFile.fileSize;
      }
    }

    // Handle deletion of new FabFileChunks
    await db.fabFileChunks.deleteManyByFabFileId(ownedFile.id);

    // Unlink the deleted fabFile from all associated sessions
    const sessions = await db.sessions.findAllWithKnowledgeId(ownedFile.id);
    for (const notebook of sessions) {
      const updatedKnowledgeIds = (notebook.knowledgeIds || []).filter(knowledgeId => knowledgeId !== ownedFile.id);
      await db.sessions.update({ id: notebook.id, knowledgeIds: updatedKnowledgeIds });
    }

    // Delete the file in S3
    for (const path of storagePathsToDelete) {
      await storage.delete(path);
    }

    // sizeToDeduct is always a positive number, representing the amount to deduct from the user's storage
    if (onDeleteComplete) {
      await onDeleteComplete(ownedFile, sizeToDeduct);
    }

    return { action: 'deleted', fabFile: ownedFile };
  }

  // 2. User doesn't own the file - check if it's shared to them
  const sharedFile = await db.fabFiles.findById(id);
  if (!sharedFile) {
    Logger.globalInstance.warn(`[deleteFabFile] File not found — fileId: ${id}, userId: ${userId}. Treating as no-op.`);
    return { action: 'not_found', fabFile: null };
  }

  const userShareIndex = sharedFile.users?.findIndex(u => u.userId.toString() === userId);
  if (userShareIndex === undefined || userShareIndex === -1) {
    // File exists but user has no direct share - may be group-shared or data-lake
    Logger.globalInstance.warn(
      `[deleteFabFile] File exists but user is not in share list — fileId: ${id}, userId: ${userId}. Cannot unshare.`
    );
    return { action: 'not_found', fabFile: null };
  }

  // 3. Remove the user from the share list (self-unshare)
  Logger.globalInstance.log(
    `[deleteFabFile] Removing user from shared file — fileId: ${sharedFile.id}, fileName: ${sharedFile.fileName}, userId: ${userId}`
  );
  sharedFile.users = sharedFile.users.filter(u => u.userId.toString() !== userId);
  await db.fabFiles.update({ id: sharedFile.id, users: sharedFile.users });

  // Clean up any sessions owned by this user that reference the now-inaccessible file
  const sessionsWithFile = await db.sessions.findAllWithKnowledgeId(sharedFile.id);
  for (const session of sessionsWithFile) {
    if (session.userId === userId) {
      const updatedKnowledgeIds = (session.knowledgeIds || []).filter(knowledgeId => knowledgeId !== sharedFile.id);
      await db.sessions.update({ id: session.id, knowledgeIds: updatedKnowledgeIds });
    }
  }

  return { action: 'unshared', fabFile: sharedFile };
};
