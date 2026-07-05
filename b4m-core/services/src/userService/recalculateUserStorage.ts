import { IFabFileRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const recalculateUserStorageSchema = z.object({
  /**
   * The user to recalculate the storage for
   */
  userId: z.string(),
});

export type RecalculateUserStorageParameters = z.infer<typeof recalculateUserStorageSchema>;

interface RecalculateUserStorageAdapters {
  db: {
    users: IUserRepository;
    fabFiles: IFabFileRepository;
  };
}

export const recalculateUserStorage = async (
  parameters: RecalculateUserStorageParameters,
  { db }: RecalculateUserStorageAdapters
) => {
  const { userId } = secureParameters(parameters, recalculateUserStorageSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError(`User ${userId} not found`);

  const fabFiles = await db.fabFiles.findByUserId(userId);
  const totalSize = fabFiles.reduce((sum, file) => sum + (file.fileSize || 0), 0);

  user.currentStorageSize = totalSize;
  await db.users.update(user);
};
