import { IBaseEvent } from '../../../types';

export enum FeedbackEvents {
  CREATE_FEEDBACK = 'Feedback Created',
  DELETE_FEEDBACK = 'Feedback Deleted',
  UPDATE_FEEDBACK = 'Feedback Updated',
  FEEDBACK_SENT = 'Feedback Sent',
}

interface ICreateFeedbackEvent extends IBaseEvent {
  type: FeedbackEvents.CREATE_FEEDBACK;
  metadata: {
    /** ID of the feedback that was created */
    id: string;
    /** Content of the feedback */
    content?: string;
  };
}

interface IDeleteFeedbackEvent extends IBaseEvent {
  type: FeedbackEvents.DELETE_FEEDBACK;
  metadata: {
    /** ID of the feedback that was deleted */
    id: string;
  };
}

interface IUpdateFeedbackEvent extends IBaseEvent {
  type: FeedbackEvents.UPDATE_FEEDBACK;
  metadata: {
    /** ID of the feedback that was updated */
    id: string;
    /** Updated content of the feedback */
    content?: string;
    status?: string;
    username?: string;
  };
}

interface IFeedbackSentEvent extends IBaseEvent {
  type: FeedbackEvents.FEEDBACK_SENT;
  metadata: {
    /** ID of the feedback that was sent */
    id: string;
    /** Content of the sent feedback */
    content?: string;
  };
}

export type FeedbackEventPayload =
  | ICreateFeedbackEvent
  | IDeleteFeedbackEvent
  | IUpdateFeedbackEvent
  | IFeedbackSentEvent;
