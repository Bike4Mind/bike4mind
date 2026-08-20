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

/**
 * What a feedback record is ABOUT, which decides how it can be rolled up. Derived server-side from
 * which foreign keys resolved, never taken from the client: a turn-scoped report needs a quest, a
 * session-scoped one needs only a session, and product feedback is attached to neither.
 */
export type FeedbackSubject = 'turn' | 'session' | 'product';

export interface IFeedback {
  userId: string;
  /**
   * The reporter's free text. OPTIONAL because it does not live on this document: it is stored in
   * the TTL'd `FeedbackText` sibling collection and joined back on read, so it is absent once that
   * document has expired (90 days) while everything else here persists. Readers must treat it as
   * possibly-absent rather than assuming a string - see FeedbackTextModel for why the split exists.
   */
  content?: string;
  status: FeedbackStatus;
  tags?: Array<string>;
  username: string;
  userEmail: string;
  customerService: string;
  organization: string;
  type: FeedbackType;
  promptMeta: PromptMeta;
  /**
   * Server-derived foreign keys (#1864). All three are resolved from the authenticated identity and
   * a re-read of the referenced quest - NEVER from the request body, because they become
   * authorization keys the moment a scoped reader (#1866) filters on them.
   *
   * TYPE TRAP: `organizationId` is an ObjectId here while the quest side
   * (`promptMeta.session.organizationId`) is a String. An aggregation `$match` across the two
   * without an explicit cast matches zero documents and throws nothing, which renders as "no
   * reports" - i.e. it reads as good news. Cast explicitly when joining.
   */
  sessionId?: string;
  questId?: string;
  organizationId?: string;
  subject: FeedbackSubject;
}

export interface IFeedbackDocument extends IFeedback, IMongoDocument {}

/**
 * The reporter's free text, split out of `Feedback` so it can expire on its own (#1864). Mongo
 * cannot TTL a single field of a document, so the text needs its own document for the retention
 * policy to be expressible at all: 90 days on free text, permanent on the structured signal.
 *
 * 90 days matches this repo's existing precedents (HelpEventModel's TTL and the context-telemetry
 * window). A TTL index rather than a scheduled job: self-maintaining, with no job to own and no
 * failure mode where retention silently stops.
 */
export interface IFeedbackText {
  feedbackId: string;
  content: string;
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

/**
 * Binary production/non-production bucket for a raw stage string. Pure so callers that need to
 * unit-test stage-dependent routing/dimensioning can pass an arbitrary stage without mocking the
 * SST-secret-loading module that owns the real deploy stage. Single source of truth for callers
 * that used to each repeat `stage === 'production'` themselves.
 */
export function classifyStage(stage: string | undefined): FeedbackDeliveryStageClass {
  return stage === 'production' ? 'production' : 'nonprod';
}

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
