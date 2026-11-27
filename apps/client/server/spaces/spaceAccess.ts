import {
  isSpaceManager,
  isSpaceOwner,
  type IInviteDocument,
  type ISpaceDocument,
  type IUserDocument,
  type SpaceJoinedVia,
} from '@bike4mind/common';
import { spaceRepository, userRepository } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { generateInviteLink } from '@server/managers/createDocumentInvite';

export interface SpacePersonView {
  userId: string;
  username: string | null;
  avatar: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedVia: SpaceJoinedVia | null;
  joinedAt: Date | null;
  /** Managers only. */
  email?: string;
}

export interface SpaceView {
  id: string;
  name: string;
  description: string | null;
  parentOrganizationId: string | null;
  viewerRole: 'owner' | 'admin' | 'member';
  memberCount: number;
  owner: SpacePersonView;
  members: SpacePersonView[];
}

export interface SpaceInviteLinkView {
  id: string;
  link: string;
  expiresAt: Date | null;
  remaining: number;
  accepted: number;
  allowedDomains: string[];
  revokedAt: Date | null;
}

const roleOf = (viewerId: string, space: Pick<ISpaceDocument, 'ownerUserId' | 'members'>) =>
  isSpaceOwner(viewerId, space) ? 'owner' : isSpaceManager(viewerId, space) ? 'admin' : 'member';

/** Members never see each other's email; owner and admins do. */
export function toSpaceView(viewer: IUserDocument, { space, users }: spaceService.SpaceWithUsers): SpaceView {
  const byId = new Map(users.map(u => [u.id, u]));
  const showEmail = isSpaceManager(viewer.id, space);
  const person = (
    userId: string,
    role: SpacePersonView['role'],
    joinedVia: SpaceJoinedVia | null,
    joinedAt: Date | null
  ): SpacePersonView => {
    const u = byId.get(userId);
    return {
      userId,
      username: u?.username ?? null,
      avatar: u?.photoUrl ?? null,
      role,
      joinedVia,
      joinedAt,
      ...(showEmail && u?.email ? { email: u.email } : {}),
    };
  };
  return {
    id: space.id,
    name: space.name,
    description: space.description ?? null,
    parentOrganizationId: space.parentOrganizationId ?? null,
    viewerRole: roleOf(viewer.id, space),
    memberCount: space.members.length + 1,
    owner: person(space.ownerUserId, 'owner', null, null),
    members: space.members.map(m => person(m.userId, m.role, m.joinedVia, m.joinedAt)),
  };
}

export const toSpaceInviteLinkView = (invite: IInviteDocument): SpaceInviteLinkView => ({
  id: invite.id,
  link: generateInviteLink(invite),
  expiresAt: invite.expiresAt ?? null,
  remaining: invite.remaining,
  accepted: invite.recipients?.accepted?.length ?? invite.accepted ?? 0,
  allowedDomains: invite.allowedDomains ?? [],
  revokedAt: invite.revokedAt ?? null,
});

/** A non-member and a missing Space answer identically. */
export async function loadSpaceForMember(user: IUserDocument, spaceId: string | undefined): Promise<ISpaceDocument> {
  if (!spaceId) throw new BadRequestError('Space id is required');
  return spaceService.loadForMember(spaceRepository, user.id, spaceId);
}

/** Owner or admin only; anyone else gets the same not-found as a stranger. */
export async function loadManagedSpace(user: IUserDocument, spaceId: string | undefined): Promise<ISpaceDocument> {
  const space = await loadSpaceForMember(user, spaceId);
  if (!isSpaceManager(user.id, space)) throw new NotFoundError('Space not found');
  return space;
}

/** The caller's view of a Space they belong to. */
export async function loadSpaceView(user: IUserDocument, spaceId: string | undefined): Promise<SpaceView> {
  if (!spaceId) throw new BadRequestError('Space id is required');
  const loaded = await spaceService.get(user, { spaceId }, { db: { spaces: spaceRepository, users: userRepository } });
  return toSpaceView(user, loaded);
}
