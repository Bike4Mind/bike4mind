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
      update: (user: Partial<IUserDocument>) => Promise<unknown>;
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

  await db.users.update({
    id: user.id,
    pendingEmail: null,
    pendingEmailToken: null,
    pendingEmailSentAt: null,
    pendingEmailExpires: null,
  });
};
