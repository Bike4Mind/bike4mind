import { IInviteDocument, IInviteRepository, IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { authorizeByInviteType, InviteTypeAuthAdapters } from './authorizeByInviteType';

const refuseWholeInviteSchema = z.object({
  id: z.string(),
});

type RefuseWholeInviteParameters = z.infer<typeof refuseWholeInviteSchema>;

interface RefuseWholeInviteAdapters {
  db: InviteTypeAuthAdapters & {
    invites: Pick<IInviteRepository, 'findById' | 'update'>;
  };
}

/**
 * Refuses an invite. A named pending recipient declining affects ONLY their own slot -
 * moved from `pending` to `refused`, `remaining` decremented by one - and must never
 * touch anyone else's slot or the invite as a whole, since a multi-recipient invite is
 * shared state across every invitee. Revoking the WHOLE invite (a link invite, or a
 * caller who is not a named pending recipient) instead requires the same share
 * authority cancelInviteById.ts enforces via `authorizeByInviteType` (owner /
 * users-share / groups-share). This replaces two holes the manager's CASL
 * `acceptOrRefuse` scope left open: any holder of a link invite id could zero it for
 * everyone, and one named recipient declining could do the same to every co-recipient.
 */
export const refuseWholeInvite = async (
  user: IUserDocument,
  parameters: RefuseWholeInviteParameters,
  { db }: RefuseWholeInviteAdapters
): Promise<IInviteDocument | null> => {
  const { id } = secureParameters(parameters, refuseWholeInviteSchema);

  const invite = await db.invites.findById(id);
  if (!invite) throw new NotFoundError('Invite not found');

  const pending = invite.recipients?.pending ?? [];
  const isPendingRecipient = !!user.email && pending.includes(user.email);

  if (isPendingRecipient) {
    invite.recipients!.pending = pending.filter(p => p !== user.email);
    invite.recipients!.refused = [...(invite.recipients!.refused ?? []), user.email as string];
    invite.remaining -= 1;
  } else {
    await authorizeByInviteType(user, invite.type, invite.documentId, db);

    invite.remaining = 0;
    if (invite.recipients) {
      invite.recipients.pending = [];
    }
  }

  await db.invites.update(invite);
  return db.invites.findById(invite.id);
};
