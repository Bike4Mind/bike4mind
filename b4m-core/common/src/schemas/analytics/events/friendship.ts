import { IBaseEvent } from '../../../types';

export enum FriendshipEvents {
  FRIENDSHIP_REQUEST = 'Friendship Requested',
  FRIENDSHIP_ACCEPT = 'Friendship Accepted',
  FRIENDSHIP_REJECT = 'Friendship Rejected',
  FRIENDSHIP_CANCEL = 'Friendship Cancelled',
}

interface IFriendshipRequestEvent extends IBaseEvent {
  type: FriendshipEvents.FRIENDSHIP_REQUEST;
  metadata: {
    /** ID of the user who sent the request */
    requesterId: string;
    /** ID of the user who received the request */
    receiverId: string;
  };
}

interface IFriendshipAcceptEvent extends IBaseEvent {
  type: FriendshipEvents.FRIENDSHIP_ACCEPT;
  metadata: {
    /** ID of the user who accepted the request */
    accepterId: string;
    /** ID of the user who sent the original request */
    requesterId: string;
  };
}

interface IFriendshipRejectEvent extends IBaseEvent {
  type: FriendshipEvents.FRIENDSHIP_REJECT;
  metadata: {
    /** ID of the user who rejected the request */
    rejecterId: string;
    /** ID of the user who sent the original request */
    requesterId: string;
  };
}

interface IFriendshipCancelEvent extends IBaseEvent {
  type: FriendshipEvents.FRIENDSHIP_CANCEL;
  metadata: {
    /** ID of the user who cancelled the friendship */
    cancellerId: string;
    /** ID of the other user in the friendship */
    otherUserId: string;
  };
}

export type FriendshipEventPayload =
  | IFriendshipRequestEvent
  | IFriendshipAcceptEvent
  | IFriendshipRejectEvent
  | IFriendshipCancelEvent;
