import { IInviteDocument, IInviteRepository, IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { authorizeByInviteType, InviteTypeAuthAdapters } from './authorizeByInviteType';

const cancelInviteByIdSchema = z.object({
  id: z.string(),
});

type CancelInviteByIdParameters = z.infer<typeof cancelInviteByIdSchema>;

interface CancelInviteByIdAdapters {
  db: InviteTypeAuthAdapters & {
    invites: Pick<IInviteRepository, 'findById' | 'update'>;
  };
}

/**
 * Cancels a SINGLE invite by its invite id (distinct from `cancelInvite`, which
 * cancels every invite on a document). Zeroes `remaining` and clears the pending
 * list but keeps `refused`. Share-scoped via `authorizeByInviteType` (owner /
 * users-share / groups-share), replacing the manager's CASL `Permission.share` check.
 */
export const cancelInviteById = async (
  user: IUserDocument,
  parameters: CancelInviteByIdParameters,
  { db }: CancelInviteByIdAdapters
): Promise<IInviteDocument | null> => {
  const { id } = secureParameters(parameters, cancelInviteByIdSchema);

  const invite = await db.invites.findById(id);
  if (!invite) throw new NotFoundError('Invite not found');

  await authorizeByInviteType(user, invite.type, invite.documentId, db);

  invite.remaining = 0;
  if (invite.recipients) {
    invite.recipients.pending = [];
  }

  await db.invites.update(invite);
  return db.invites.findById(id);
};
