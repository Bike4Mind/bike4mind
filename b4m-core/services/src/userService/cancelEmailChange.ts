import { IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const cancelEmailChangeSchema = z.object({
  userId: z.string(),
});

export type CancelEmailChangeParameters = z.infer<typeof cancelEmailChangeSchema>;

interface CancelEmailChangeAdapters {
  db: {
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
      update: (user: IUserDocument) => Promise<unknown>;
    };
  };
}

export const cancelEmailChange = async (
  params: CancelEmailChangeParameters,
  { db }: CancelEmailChangeAdapters
): Promise<void> => {
  const { userId } = secureParameters(params, cancelEmailChangeSchema);

  const user = await db.users.findById(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  user.pendingEmail = null;
  user.pendingEmailToken = null;
  user.pendingEmailSentAt = null;
  user.pendingEmailExpires = null;

  await db.users.update(user);
};
