import { ConflictError, ISpaceRepository, IUserDocument, isSpaceOwner } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { loadForMember } from './loadForMember';

const leaveSchema = z.object({ spaceId: z.string().min(1) });

type LeaveParameters = z.infer<typeof leaveSchema>;

interface LeaveAdapters {
  db: { spaces: Pick<ISpaceRepository, 'findLiveById' | 'removeMember'> };
}

/** A voluntary leave does not block a rejoin through a link. The owner must transfer or delete instead. */
export async function leave(user: IUserDocument, parameters: LeaveParameters, adapters: LeaveAdapters): Promise<void> {
  const { spaceId } = secureParameters(parameters, leaveSchema);
  const { db } = adapters;

  const space = await loadForMember(db.spaces, user.id, spaceId);
  if (isSpaceOwner(user.id, space)) {
    throw new ConflictError('Transfer ownership or delete the space before leaving');
  }

  // A null result means a concurrent change already took the row out, which is the outcome asked for.
  await db.spaces.removeMember(spaceId, user.id, { block: false });
}
