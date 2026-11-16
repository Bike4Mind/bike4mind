import { ISpaceDocument, ISpaceRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { loadForMember } from './loadForMember';

const getSchema = z.object({ spaceId: z.string().min(1) });

type GetParameters = z.infer<typeof getSchema>;

interface GetAdapters {
  db: {
    spaces: Pick<ISpaceRepository, 'findLiveById'>;
    users: Pick<IUserRepository, 'findByIds'>;
  };
}

export interface SpaceWithUsers {
  space: ISpaceDocument;
  /** The owner and every member, for the caller's view builder. */
  users: Awaited<ReturnType<IUserRepository['findByIds']>>;
}

export async function get(
  user: IUserDocument,
  parameters: GetParameters,
  adapters: GetAdapters
): Promise<SpaceWithUsers> {
  const { spaceId } = secureParameters(parameters, getSchema);
  const space = await loadForMember(adapters.db.spaces, user.id, spaceId);
  const users = await adapters.db.users.findByIds([space.ownerUserId, ...space.members.map(m => m.userId)]);
  return { space, users };
}
