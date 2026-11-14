import { IBaseRepository, IMongoDocument } from '.';

export type SpaceMemberRole = 'admin' | 'member';
export type SpaceJoinedVia = 'invite' | 'link' | 'domain';

export interface ISpaceMember {
  userId: string;
  role: SpaceMemberRole;
  joinedVia: SpaceJoinedVia;
  joinedAt: Date;
}

/** A user-owned group. The owner is `ownerUserId` and never a row in `members`. */
export interface ISpace {
  name: string;
  description?: string | null;
  ownerUserId: string;
  members: ISpaceMember[];
  /** Users an admin removed; a join link refuses them, a named invite clears the entry. */
  removedUserIds: string[];
  parentOrganizationId?: string | null;
  deletedAt?: Date | null;
}

export interface ISpaceDocument extends ISpace, IMongoDocument {}

export const MAX_OWNED_SPACES = 20;
export const SPACE_NAME_MAX = 80;
export const SPACE_DESCRIPTION_MAX = 500;
export const SPACE_CREATION_REQUIRES_PAID_STANDING_CODE = 'SPACE_CREATION_REQUIRES_PAID_STANDING';
export const SPACE_LIMIT_REACHED_CODE = 'SPACE_LIMIT_REACHED';

export interface AddSpaceMemberOptions {
  /** Most members the Space may hold, not counting the owner. */
  cap: number;
  /** Lift a prior admin removal (a named invite does; a join link does not). */
  clearRemoved: boolean;
}

export interface ISpaceRepository extends IBaseRepository<ISpaceDocument> {
  findLiveById: (id: string) => Promise<ISpaceDocument | null>;
  listForUser: (userId: string) => Promise<ISpaceDocument[]>;
  countOwned: (userId: string) => Promise<number>;
  /** `null` when the Space is gone or full, or the user is the owner, a member, or blocked. */
  addMember: (spaceId: string, member: ISpaceMember, options: AddSpaceMemberOptions) => Promise<ISpaceDocument | null>;
  removeMember: (spaceId: string, userId: string, options: { block: boolean }) => Promise<ISpaceDocument | null>;
  setMemberRole: (spaceId: string, userId: string, role: SpaceMemberRole) => Promise<ISpaceDocument | null>;
  /** `null` unless `fromUserId` owns the Space and `toUserId` is one of its admins. */
  transferOwnership: (
    spaceId: string,
    fromUserId: string,
    toUserId: string,
    options: { clearParent: boolean }
  ) => Promise<ISpaceDocument | null>;
  updateDetails: (
    spaceId: string,
    details: { name?: string; description?: string | null; parentOrganizationId?: string | null }
  ) => Promise<ISpaceDocument | null>;
  softDelete: (spaceId: string, ownerUserId: string) => Promise<boolean>;
}

type SpaceAccessShape = Pick<ISpace, 'ownerUserId' | 'members'>;

export const isSpaceOwner = (userId: string, space: SpaceAccessShape): boolean => space.ownerUserId === userId;

export const isSpaceMember = (userId: string, space: SpaceAccessShape): boolean =>
  isSpaceOwner(userId, space) || space.members.some(m => m.userId === userId);

export const isSpaceManager = (userId: string, space: SpaceAccessShape): boolean =>
  isSpaceOwner(userId, space) || space.members.some(m => m.userId === userId && m.role === 'admin');
