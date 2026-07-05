import { IInvite, IUserDocument } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const refuseInviteSchema = z.object({
  id: z.string(),
});

type RefuseInviteParameters = z.infer<typeof refuseInviteSchema>;

interface RefuseInviteAdapters {
  db: {
    invites: {
      findByIdAndPendingEmail: (id: string, email: string) => Promise<IInvite>;
      update(data: IInvite): Promise<unknown>;
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

  if (invite.recipients) {
    invite.recipients.pending = invite.recipients.pending?.filter(p => p !== user.email);
    invite.recipients.refused.push(user.email);
    invite.remaining -= 1;
  }

  await db.invites.update(invite);

  return invite;
};
