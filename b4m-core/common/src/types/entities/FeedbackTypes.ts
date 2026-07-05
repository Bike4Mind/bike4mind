import { IMongoDocument } from '.';
import { PromptMeta } from './PromptMetaTypes';
export enum FeedbackStatus {
  New = 'New',
  Closed = 'Closed',
  InProgress = 'InProgress',
}

export enum FeedbackType {
  BUG = 'Bug',
  FEEDBACK = 'Feedback',
  THUMBS_UP = 'Thumbs Up',
  THUMBS_DOWN = 'Thumbs Down',
}

export interface IFeedback {
  userId: string;
  content: string;
  status: FeedbackStatus;
  tags?: Array<string>;
  username: string;
  userEmail: string;
  customerService: string;
  organization: string;
  type: FeedbackType;
  promptMeta: PromptMeta;
}

export interface IFeedbackDocument extends IFeedback, IMongoDocument {}
