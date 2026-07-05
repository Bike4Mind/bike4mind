import { IBaseEvent } from '../../../types';

export enum InboxEvents {
  CREATE_INBOX = 'Inbox Created',
  DELETE_INBOX = 'Inbox Deleted',
  READ_INBOX = 'Inbox Read',
}

interface ICreateInboxEvent extends IBaseEvent {
  type: InboxEvents.CREATE_INBOX;
  metadata: {
    /** ID of the inbox that was created */
    id: string;
  };
}

interface IDeleteInboxEvent extends IBaseEvent {
  type: InboxEvents.DELETE_INBOX;
  metadata: {
    /** ID of the inbox that was deleted */
    id: string;
  };
}

interface IReadInboxEvent extends IBaseEvent {
  type: InboxEvents.READ_INBOX;
  metadata: {
    /** IDs of the inboxes that was read */
    ids: string[];
  };
}

export type InboxEventPayload = ICreateInboxEvent | IDeleteInboxEvent | IReadInboxEvent;
