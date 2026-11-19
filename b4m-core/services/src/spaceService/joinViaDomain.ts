import {
  ConflictError,
  ForbiddenError,
  ISpaceDocument,
  ISpaceRepository,
  IUserDocument,
  isSpaceMember,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const joinViaDomainSchema = z.object({ spaceId: z.string().min(1) });

type JoinViaDomainParameters = z.infer<typeof joinViaDomainSchema>;

interface JoinViaDomainAdapters {
  db: { spaces: Pick<ISpaceRepository, 'findLiveById' | 'addMember'> };
  limits: { spaceMaxMembers: number };
  /** The claim rule, owned by the app layer: the Space's own verified `suggest` claim or an inherited parent claim. */
  isDomainJoinable: (space: ISpaceDocument, email: string) => Promise<boolean>;
}

/**
 * An explicit join by the caller's verified email domain, always as a plain member. A missing Space
 * and an ineligible address answer alike, so the id cannot be probed. A removed user stays refused.
 */
export async function joinViaDomain(
  user: IUserDocument,
  parameters: JoinViaDomainParameters,
  adapters: JoinViaDomainAdapters
): Promise<void> {
  const { spaceId } = secureParameters(parameters, joinViaDomainSchema);
  const { db, limits, isDomainJoinable } = adapters;

  if (user.emailVerified !== true) throw new ForbiddenError('Verify your email address before joining');
  const space = await db.spaces.findLiveById(spaceId);
  if (!space || !user.email || !(await isDomainJoinable(space, user.email))) {
    throw new ForbiddenError('Your email domain does not grant access to this Space');
  }
  if (isSpaceMember(user.id, space)) throw new ConflictError('You are already a member of this space');

  const added = await db.spaces.addMember(
    spaceId,
    { userId: user.id, role: 'member', joinedVia: 'domain', joinedAt: new Date() },
    { cap: limits.spaceMaxMembers, clearRemoved: false }
  );
  if (added) return;

  const current = await db.spaces.findLiveById(spaceId);
  if (!current) throw new NotFoundError('Space not found');
  if (isSpaceMember(user.id, current)) throw new ConflictError('You are already a member of this space');
  if (current.removedUserIds.includes(user.id)) throw new ForbiddenError('You cannot join this space');
  throw new ForbiddenError('This space is full');
}
