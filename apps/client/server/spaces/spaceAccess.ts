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

type SpaceUser = Pick<IUserDocument, 'id' | 'username' | 'email' | 'photoUrl'>;

const personOf = (
  byId: Map<string, SpaceUser>,
  showEmail: boolean,
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

/** Members never see each other's email; owner and admins do. */
export function toSpaceView(viewer: IUserDocument, { space, users }: spaceService.SpaceWithUsers): SpaceView {
  const byId = new Map<string, SpaceUser>(users.map(u => [u.id, u]));
  const showEmail = isSpaceManager(viewer.id, space);
  return {
    id: space.id,
    name: space.name,
    description: space.description ?? null,
    parentOrganizationId: space.parentOrganizationId ?? null,
    viewerRole: roleOf(viewer.id, space),
    memberCount: space.members.length + 1,
    owner: personOf(byId, showEmail, space.ownerUserId, 'owner', null, null),
    members: space.members.map(m => personOf(byId, showEmail, m.userId, m.role, m.joinedVia, m.joinedAt)),
  };
}

export type AdminSpaceView = Omit<SpaceView, 'viewerRole'> & { createdAt: Date };

/** The platform admin's view: every email and role, and no viewer role since the admin is not a member. */
export function toAdminSpaceView(space: ISpaceDocument, users: SpaceUser[]): AdminSpaceView {
  const byId = new Map(users.map(u => [u.id, u]));
  return {
    id: space.id,
    name: space.name,
    description: space.description ?? null,
    parentOrganizationId: space.parentOrganizationId ?? null,
    memberCount: space.members.length + 1,
    createdAt: space.createdAt,
    owner: personOf(byId, true, space.ownerUserId, 'owner', null, null),
    members: space.members.map(m => personOf(byId, true, m.userId, m.role, m.joinedVia, m.joinedAt)),
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
