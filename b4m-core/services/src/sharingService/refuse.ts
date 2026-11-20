import { IInvite, IUserDocument } from '@bike4mind/common';
import { BadRequestError, secureParameters, UnprocessableEntityError } from '@bike4mind/utils';
import { z } from 'zod';

const refuseInviteSchema = z.object({
  id: z.string(),
});

type RefuseInviteParameters = z.infer<typeof refuseInviteSchema>;

interface RefuseInviteAdapters {
  db: {
    invites: {
      findByIdAndPendingEmail: (id: string, email: string) => Promise<IInvite>;
      refusePendingRecipient: (id: string, email: string) => Promise<IInvite | null>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument>;
    };
  };
}

export const refuseInvite = async (
  userId: string,
  parameters: RefuseInviteParameters,
  { db }: RefuseInviteAdapters
) => {
  const user = await db.users.findById(userId);
  if (!user) throw new BadRequestError('User not found');
  if (!user.email) throw new BadRequestError('User has no email');

  const { id } = secureParameters(parameters, refuseInviteSchema);

  const invite = await db.invites.findByIdAndPendingEmail(id, user.email);

  // createInvite defaults expiresAt 100 years out, so this only bites a real expiration.
  if (invite.expiresAt && invite.expiresAt < new Date()) {
    throw new UnprocessableEntityError('Invite has expired');
  }

  if (!invite.recipients) return invite;
  return (await db.invites.refusePendingRecipient(invite.id, user.email)) ?? invite;
};
