import { IInviteDocument, IInviteRepository, IUserDocument } from '@bike4mind/common';
import { z } from 'zod';

export const listOwnPendingInvitesSchema = z.object({
  limit: z.number().min(1).max(100).prefault(20),
  page: z.number().min(1).prefault(1),
});

interface ListOwnPendingInvitesAdapters {
  db: {
    invites: IInviteRepository;
  };
}

export const listOwnPendingInvites = async (
  user: IUserDocument,
  params: z.infer<typeof listOwnPendingInvitesSchema>,
  { db }: ListOwnPendingInvitesAdapters
): Promise<{ data: IInviteDocument[]; total: number }> => {
  // Matching is by the user's stored email (resolved inside the repository), so
  // the email argument is no longer passed.
  const allData = await db.invites.findAllByPendingUserIdOrEmail(user.id, {
    limit: 1000, // Get all for count
    page: 1,
  });
  const count = allData.length;

  const data = await db.invites.findAllByPendingUserIdOrEmail(user.id, {
    limit: params.limit,
    page: params.page,
  });

  return { data, total: count };
};
