import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export enum FriendshipStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  BLOCKED = 'blocked',
}

export interface IFriendshipDocument extends IMongoDocument {
  /** User who sends the friend request */
  requester: string;
  /** User who receives the friend request */
  recipient: string;
  /** Status of the request */
  status: FriendshipStatus;
  /** Message sent with the friend request */
  message?: string;
}

export interface IFriendshipModelAdapter extends IBaseRepository<IFriendshipDocument> {
  findById: (id: string) => Promise<IFriendshipDocument | null>;
  deleteById: (id: string) => Promise<void>;
  findByUsers: (userId1: string, userId2: string) => Promise<IFriendshipDocument | null>;
  updateStatus: (id: string, status: FriendshipStatus) => Promise<IFriendshipDocument>;
  deleteByUsers: (userId1: string, userId2: string) => Promise<void>;
  /** Find all friends of a user */
  findAllForUser: (
    userId: string,
    options?: {
      status?: FriendshipStatus | FriendshipStatus[];
    }
  ) => Promise<IFriendshipDocument[]>;
}
