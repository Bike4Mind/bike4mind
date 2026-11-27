import { ForbiddenError, ISpaceDocument, ISpaceRepository, IUserDocument, isSpaceOwner } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { loadForMember } from './loadForMember';

const setMemberRoleSchema = z.object({
  spaceId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(['admin', 'member']),
});

type SetMemberRoleParameters = z.infer<typeof setMemberRoleSchema>;

interface SetMemberRoleAdapters {
  db: { spaces: Pick<ISpaceRepository, 'findLiveById' | 'setMemberRole'> };
}

export async function setMemberRole(
  user: IUserDocument,
  parameters: SetMemberRoleParameters,
  adapters: SetMemberRoleAdapters
): Promise<ISpaceDocument> {
  const { spaceId, userId, role } = secureParameters(parameters, setMemberRoleSchema);
  const { db } = adapters;

  const space = await loadForMember(db.spaces, user.id, spaceId);
  if (!isSpaceOwner(user.id, space)) throw new ForbiddenError('Only the owner can change roles');

  const updated = await db.spaces.setMemberRole(spaceId, userId, role);
  if (!updated) throw new NotFoundError('Member not found');
  return updated;
}
