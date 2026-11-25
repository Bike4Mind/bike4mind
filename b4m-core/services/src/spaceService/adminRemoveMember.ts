import {
  ConflictError,
  ForbiddenError,
  IInviteRepository,
  ISpaceDocument,
  ISpaceRepository,
  IUserDocument,
  isSpaceOwner,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const adminRemoveMemberSchema = z.object({ spaceId: z.string().min(1), userId: z.string().min(1) });

type AdminRemoveMemberParameters = z.infer<typeof adminRemoveMemberSchema>;

interface AdminRemoveMemberAdapters {
  db: {
    spaces: Pick<ISpaceRepository, 'findLiveById' | 'removeMember'>;
    invites: Pick<IInviteRepository, 'findAllByDocumentId' | 'cancelPendingRecipient'>;
    users: { findById: (id: string) => Promise<IUserDocument | null> };
  };
}

/**
 * Platform admin removal of any non-owner member, of any role. The route checks the admin; this does not.
 * The removed user cannot rejoin by link. Returns the Space as it was before the removal.
 */
export async function adminRemoveMember(
  _admin: IUserDocument,
  parameters: AdminRemoveMemberParameters,
  adapters: AdminRemoveMemberAdapters
): Promise<ISpaceDocument> {
  const { spaceId, userId } = secureParameters(parameters, adminRemoveMemberSchema);
  const { db } = adapters;

  const space = await db.spaces.findLiveById(spaceId);
  if (!space) throw new NotFoundError('Space not found');
  if (isSpaceOwner(userId, space)) {
    throw new ForbiddenError('Delete the Space or ask the owner to transfer it');
  }
  if (!space.members.some(m => m.userId === userId)) throw new NotFoundError('Member not found');

  const removed = await db.spaces.removeMember(spaceId, userId, { block: true });
  if (!removed) throw new ConflictError('Membership changed; reload and try again');

  // A named invite still pending for the removed user would otherwise clear the block and re-admit them.
  const removedUser = await db.users.findById(userId);
  const email = (removedUser?.email ?? '').trim().toLowerCase();
  if (!email) return space;
  const invites = await db.invites.findAllByDocumentId(spaceId);
  for (const invite of invites) {
    if (invite.revokedAt) continue;
    const pending = (invite.recipients?.pending ?? []).some(address => address.trim().toLowerCase() === email);
    if (pending) await db.invites.cancelPendingRecipient(invite.id, email);
  }
  return space;
}
