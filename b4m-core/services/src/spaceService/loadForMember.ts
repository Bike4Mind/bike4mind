import { ISpaceDocument, ISpaceRepository, isSpaceMember } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

/** One answer for a missing and a forbidden Space, so the id cannot be probed. */
export async function loadForMember(
  spaces: Pick<ISpaceRepository, 'findLiveById'>,
  userId: string,
  spaceId: string
): Promise<ISpaceDocument> {
  const space = await spaces.findLiveById(spaceId);
  if (!space || !isSpaceMember(userId, space)) throw new NotFoundError('Space not found');
  return space;
}
