import { IMongoDocument } from '.';
import { PromptMeta } from './PromptMetaTypes';
import { IOrganizationDocument } from './OrganizationTypes';

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

/** What a feedback report is about - server-derived from what the submission actually resolved
 * to, never client-set (see the create handler). */
export const FEEDBACK_SUBJECTS = ['turn', 'session', 'product'] as const;
export type FeedbackSubject = (typeof FEEDBACK_SUBJECTS)[number];

export interface IFeedback {
  userId: string;
  /** Moved to `IFeedbackText` (a TTL'd sibling document sharing this doc's `_id`) 90 days after
   * creation - optional here because an expired or same-request-write-failure report has none. */
  content?: string;
  status: FeedbackStatus;
  tags?: Array<string>;
  username: string;
  userEmail: string;
  customerService: string;
  /** Display name only (kept for backward compatibility) - `organizationId` below is the actual
   * authorization key; the two are resolved from the same source and cannot disagree. */
  organization: string;
  type: FeedbackType;
  promptMeta: PromptMeta;
  /** Server-derived from the authenticated session's quest/session re-read - never trust
   * `promptMeta`'s copy of these for authorization (see the create handler). */
  sessionId?: string;
  questId?: string;
  organizationId?: IOrganizationDocument['id'] | null;
  subject: FeedbackSubject;
  /** True iff the sibling `IFeedbackText` document was successfully written - lets a reader tell
   * "text expired under the 90-day TTL" apart from "this report never had text". */
  contentStored: boolean;
}

export interface IFeedbackDocument extends IFeedback, IMongoDocument {}

/**
 * The free-text half of a Feedback report, split into its own TTL'd collection because Mongo's
 * TTL monitor deletes whole documents, not fields - `content` cannot expire on its own if it
 * lives on the permanent `IFeedbackDocument`.
 *
 * `_id` is always the owning `IFeedbackDocument`'s `_id` (see `FeedbackTextModel.ts`), so the
 * join back to the report is a plain `findById`/`$in` lookup, and "more than one text per report"
 * is structurally impossible rather than merely disallowed.
 */
export interface IFeedbackText {
  content: string;
  contentTruncated: boolean;
  expiresAt: Date;
}

export interface IFeedbackTextDocument extends IFeedbackText, IMongoDocument {}

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
