import { IBaseEvent } from '../../../types';

export enum RegInviteEvents {
  CREATE_REGINVITE = 'Registration Invite Created',
  DELETE_REGINVITE = 'Registration Invite Deleted',
  UPDATE_REGINVITE = 'Registration Invite Updated',
  REFER_REGINVITE = 'Referral Sent',
  REGINVITE_USER_INVITE = 'User Invited',
  MIGRATE_REGINVITE = 'Migration Email Sent',
}

interface ICreateRegInviteEvent extends IBaseEvent {
  type: RegInviteEvents.CREATE_REGINVITE;
  metadata: {
    /** Total number of invites created */
    totalInvites: number;
  };
}

interface IDeleteRegInviteEvent extends IBaseEvent {
  type: RegInviteEvents.DELETE_REGINVITE;
  metadata: {
    /** IDs of the registration invites that was deleted */
    ids: string[];
  };
}

interface IUpdateRegInviteEvent extends IBaseEvent {
  type: RegInviteEvents.UPDATE_REGINVITE;
  metadata: {
    /** IDs of the registration invites that was updated */
    ids: string[];
    /** New status of the registration invite */
    status: string;
  };
}

interface IReferRegInviteEvent extends IBaseEvent {
  type: RegInviteEvents.REFER_REGINVITE;
  metadata: {
    /** IDs of the registration invites that was referred */
    ids: string[];
    /** Referred emails */
    referredEmails: string[];
  };
}

interface IRegInviteUserInviteEvent extends IBaseEvent {
  type: RegInviteEvents.REGINVITE_USER_INVITE;
  // No metadata is captured for this event yet.
  metadata: {};
}

interface IMigrateRegInviteEvent extends IBaseEvent {
  type: RegInviteEvents.MIGRATE_REGINVITE;
  metadata: {};
}

export type RegInviteEventPayload =
  | ICreateRegInviteEvent
  | IDeleteRegInviteEvent
  | IUpdateRegInviteEvent
  | IReferRegInviteEvent
  | IRegInviteUserInviteEvent
  | IMigrateRegInviteEvent;
