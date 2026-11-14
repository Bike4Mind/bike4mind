import { ForbiddenError, ISpaceRepository, IUserDocument, isSpaceManager, isSpaceOwner } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { loadForMember } from './loadForMember';

const removeMemberSchema = z.object({ spaceId: z.string().min(1), userId: z.string().min(1) });

type RemoveMemberParameters = z.infer<typeof removeMemberSchema>;

interface RemoveMemberAdapters {
  db: { spaces: Pick<ISpaceRepository, 'findLiveById' | 'removeMember'> };
}

/** The owner removes anyone; an admin removes plain members only. The removed user cannot rejoin by link. */
export async function removeMember(
  user: IUserDocument,
  parameters: RemoveMemberParameters,
  adapters: RemoveMemberAdapters
): Promise<void> {
  const { spaceId, userId } = secureParameters(parameters, removeMemberSchema);
  const { db } = adapters;

  const space = await loadForMember(db.spaces, user.id, spaceId);
  if (!isSpaceManager(user.id, space)) throw new ForbiddenError('Only a Space admin can remove members');
  if (isSpaceOwner(userId, space)) throw new ForbiddenError('The owner cannot be removed');

  const target = space.members.find(m => m.userId === userId);
  if (!target) throw new NotFoundError('Member not found');
  if (target.role === 'admin' && !isSpaceOwner(user.id, space)) {
    throw new ForbiddenError('Only the owner can remove an admin');
  }

  await db.spaces.removeMember(spaceId, userId, { block: true });
}
