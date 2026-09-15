import { IBaseEvent } from '../../../types';

export enum InviteEvents {
  CREATE_INVITE = 'Invite Created',
  DELETE_INVITE = 'Invite Deleted',
}

interface ICreateInviteEvent extends IBaseEvent {
  type: InviteEvents.CREATE_INVITE;
  metadata: {
    /** ID of the invite that was created */
    id: string;
    /** Total number of invites created */
    totalInvites: number;
  };
}

interface IDeleteInviteEvent extends IBaseEvent {
  type: InviteEvents.DELETE_INVITE;
  metadata: {
    /** ID and type of the document that was used to cancel invites */
    documentId: string;
    documentType: string;
  };
}

export type InviteEventPayload = ICreateInviteEvent | IDeleteInviteEvent;
