import { IInviteDocument, IInviteRepository, IUserRepository } from '@bike4mind/common';
import { ForbiddenError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const refuseWholeInviteSchema = z.object({
  id: z.string(),
  isPublic: z.boolean().optional().default(false),
});

type RefuseWholeInviteParameters = z.infer<typeof refuseWholeInviteSchema>;

interface RefuseWholeInviteAdapters {
  db: {
    invites: Pick<IInviteRepository, 'findById' | 'update'>;
    users: Pick<IUserRepository, 'findById'>;
  };
}

/**
 * Refuses an invite for everyone: zeroes `remaining`, clears the pending list, and
 * records the caller in `refused` (the app-level manager's whole-invite semantics,
 * distinct from the own-slot `refuse`). Authorization replaces the manager's CASL
 * `acceptOrRefuse` scope, which was computed-then-ignored - so the manager let ANY
 * authenticated user refuse ANY invite. We now require the caller to actually be a
 * recipient: an email invite (pending set) may only be refused by a pending
 * recipient; a link invite (no pending list) or an explicit `isPublic` refuse is
 * open, matching the CASL `$or` arm.
 */
export const refuseWholeInvite = async (
  userId: string,
  parameters: RefuseWholeInviteParameters,
  { db }: RefuseWholeInviteAdapters
): Promise<IInviteDocument | null> => {
  const { id, isPublic } = secureParameters(parameters, refuseWholeInviteSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const invite = await db.invites.findById(id);
  if (!invite) throw new NotFoundError('Invite not found');

  // NOTE: createInvite stores `pending: []` for a link invite (not undefined), so an
  // empty pending list means "link invite OR a fully-consumed email invite" - both are
  // treated as public-refusable here. Only a still-pending email invite (a non-empty
  // pending list) is restricted to its named recipients.
  const pending = invite.recipients?.pending;
  const isEmailInvite = Array.isArray(pending) && pending.length > 0;
  const isPendingRecipient = isEmailInvite && !!user.email && pending!.includes(user.email);
  if (!isPublic && isEmailInvite && !isPendingRecipient) {
    throw new ForbiddenError('Not authorized to refuse this invite');
  }

  invite.remaining = 0;
  if (invite.recipients) {
    invite.recipients.pending = [];
    invite.recipients.refused = user.email ? [user.email] : [];
  }

  await db.invites.update(invite);
  return db.invites.findById(invite.id);
};
