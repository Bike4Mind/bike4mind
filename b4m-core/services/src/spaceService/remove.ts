import {
  ForbiddenError,
  IInviteRepository,
  ISpaceRepository,
  IUserDocument,
  InviteType,
  isSpaceOwner,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { loadForMember } from './loadForMember';

const removeSchema = z.object({ spaceId: z.string().min(1) });

type RemoveParameters = z.infer<typeof removeSchema>;

interface RemoveAdapters {
  db: {
    spaces: Pick<ISpaceRepository, 'findLiveById' | 'softDelete'>;
    invites: Pick<IInviteRepository, 'revokeAllForDocument'>;
  };
}

/** Owner only. Soft-deletes the Space, then revokes every live invite for it. Caller wraps in withTransaction. */
export async function remove(
  user: IUserDocument,
  parameters: RemoveParameters,
  adapters: RemoveAdapters
): Promise<void> {
  const { spaceId } = secureParameters(parameters, removeSchema);
  const { db } = adapters;

  const space = await loadForMember(db.spaces, user.id, spaceId);
  if (!isSpaceOwner(user.id, space)) throw new ForbiddenError('Only the owner can delete a Space');

  if (!(await db.spaces.softDelete(spaceId, user.id))) throw new NotFoundError('Space not found');
  await db.invites.revokeAllForDocument(spaceId, InviteType.Space);
}
