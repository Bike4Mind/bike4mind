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

/**
 * Delivery-outcome types for the feedback notification fan-out (Slack + email). These describe
 * whether a submitted feedback record actually reached a human, independent of FeedbackStatus
 * above (which is an admin-triage workflow state and has nothing to do with delivery).
 */
export type FeedbackDeliveryChannel = 'slack' | 'email';

/** 'production' is the only real-production signal (Resource.App.stage === 'production'); every other stage is 'nonprod'. */
export type FeedbackDeliveryStageClass = 'production' | 'nonprod';

export type FeedbackDeliverySkipReason = 'disabled' | 'no_recipients' | 'unconfigured_webhook' | 'nonprod_unconfigured';

export interface FeedbackChannelDelivery {
  outcome: 'delivered' | 'skipped' | 'failed';
  reason?: FeedbackDeliverySkipReason | 'error';
}

export interface FeedbackDeliveryResult {
  /** True iff at least one channel actually fired - not merely attempted. */
  delivered: boolean;
  channels: Record<FeedbackDeliveryChannel, FeedbackChannelDelivery>;
}

/** POST /api/feedback response: the saved document plus how far delivery got. */
export type CreateFeedbackResponse = IFeedbackDocument & { delivery?: FeedbackDeliveryResult };
