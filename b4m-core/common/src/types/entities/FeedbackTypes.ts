import { z } from 'zod';
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
 * to, never client-set (see the create handler). 'help' is derived from the route that wrote the
 * report rather than from a resolved quest/session, so `resolveFeedbackContext` never returns it;
 * the help handlers set it directly. */
export const FEEDBACK_SUBJECTS = ['turn', 'session', 'product', 'help'] as const;
export type FeedbackSubject = (typeof FEEDBACK_SUBJECTS)[number];

/** Which help-center surface a routed comment was written on. */
export const HELP_FEEDBACK_SURFACES = ['article', 'chat'] as const;
export type HelpFeedbackSurface = (typeof HELP_FEEDBACK_SURFACES)[number];

/** The thumbs verdict on a help article or help-chat answer. Single source of truth for the store
 * that persists it (`HelpEvent.rating`), the request schemas that accept it, and the derivation of
 * a routed report's `FeedbackType` - they have to agree or a valid submission fails one side's
 * validation. */
export const HELP_FEEDBACK_RATINGS = ['helpful', 'not_helpful'] as const;
export type HelpFeedbackRating = (typeof HELP_FEEDBACK_RATINGS)[number];

/** Structured problem reports a reader can file against an article, alongside the thumbs. Single
 * source of truth for the same three consumers `HELP_FEEDBACK_RATINGS` serves. */
export const HELP_FEEDBACK_REPORT_TYPES = ['outdated'] as const;
export type HelpFeedbackReportType = (typeof HELP_FEEDBACK_REPORT_TYPES)[number];

/**
 * Identifying context copied onto a report routed from the help center, so that a permanent row
 * saying "this help answer was wrong" is still actionable on its own. Deliberately carries no
 * free text: the slug and the outdated report are structured signal and are safe to keep
 * permanently, whereas the chat question and answer are not, and stay on the 90-day `HelpEvent`
 * row that `eventId` points at.
 *
 * The thumbs verdict is deliberately NOT among these fields. It lives on the report as `type`
 * (see `feedbackTypeForRating`), which is what every reader renders and filters on; a second copy
 * here would be a field nothing reads that two concurrent writers could still disagree about.
 *
 * These rows carry no `sessionId`/`questId`, so they are invisible to the session-scoped reader
 * by design - `subject: 'help'` plus `organizationId` is how they are found instead.
 */
export interface IHelpFeedbackContext {
  /** The `HelpEvent` row this comment annotates. The event expires on a 90-day TTL and this
   * report does not, so the join goes dead while the row lives on - which is exactly why the
   * fields below are copied rather than read through it. */
  eventId: string;
  surface: HelpFeedbackSurface;
  /** Article slug - set for the 'article' surface only; help chat has no slug. */
  slug?: string;
  /** Set for the 'article' surface only; help chat has nothing to report as outdated. */
  reportType?: HelpFeedbackReportType;
}

/**
 * Page bounds for the feedback list endpoint. Shared rather than mirrored on each side: the
 * server rejects a larger `limit`, and the CSV export pages at exactly the maximum - so a lower
 * server cap with a stale client copy turns every export request into a validation error.
 */
export const FEEDBACK_LIST_DEFAULT_LIMIT = 20;
export const FEEDBACK_LIST_MAX_LIMIT = 100;

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
  /** The turn that was on screen when a session-subject report was written - context only, never
   * the subject, so it does not promote `subject` to 'turn'. Server-derived like the keys above,
   * and only kept when the quest belongs to the resolved `sessionId`. */
  contextQuestId?: string;
  organizationId?: IOrganizationDocument['id'] | null;
  subject: FeedbackSubject;
  /** Set only on reports routed from the help center (`subject: 'help'`). */
  helpContext?: IHelpFeedbackContext;
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

/** POST /api/feedback response: the saved document plus how far delivery got.
 * `contentTruncated` is echoed here (not read off the document itself - it lives on the
 * FeedbackText sibling, not FeedbackModel) so a caller can tell the submitter their text was cut. */
export type CreateFeedbackResponse = IFeedbackDocument & {
  delivery?: FeedbackDeliveryResult;
  contentTruncated?: boolean;
};

/** One `{ key, count }` row of a report grouping. `key` is the grouped field's value. */
export interface FeedbackCountBucket {
  key: string;
  count: number;
}

/**
 * Feedback rollup: counts only, never content and never a username. The window is capped in DAYS
 * because every $facet arm groups the whole matched set in memory before its own top-N cut, so
 * the day cap is what bounds the rows those groupings accumulate over.
 */
export const FEEDBACK_ROLLUP_MAX_WINDOW_DAYS = 366;

/**
 * Keys kept per rollup dimension. The day cap bounds rows scanned, not DISTINCT keys, so an
 * unbounded dimension (sessionId, questId, tags) needs its own ceiling. Shared so a client caption naming the
 * ceiling reads the same number the server applied.
 */
export const FEEDBACK_ROLLUP_TOP_N = 25;

const ROLLUP_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads a rollup bound as a UTC instant. The schema below accepts an offset-less value (what a
 * date picker emits), and a bare `new Date` would read that in the host's local zone - so the
 * same query would cover a different window depending on where it ran.
 */
export function parseFeedbackRollupBound(value: string): Date {
  return new Date(/([Zz]|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
}

/**
 * GET /api/feedback/rollup query contract. There is deliberately no `userId` key: the server
 * derives the principal from the session, so `?userId=<someone-else>` is stripped here rather
 * than trusted. The window is INCLUSIVE at both ends in UTC (`$gte from`, `$lte to`): `to` is the
 * last instant included, so a caller tiling consecutive windows counts a row on a shared bound
 * twice. Both aggregations compose their scope through buildFeedbackWindowFilter
 * (@bike4mind/database), which is what keeps the personal rollup and orgFeedbackReport from
 * disagreeing about the documents sitting exactly on a bound. Agreeing on the bound is all it buys: an org total
 * equals the personal totals under it only when those are scoped `{ userId, organizationId }`.
 */
export const FeedbackRollupQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true, local: true }),
    to: z.iso.datetime({ offset: true, local: true }),
  })
  .refine(query => parseFeedbackRollupBound(query.from) < parseFeedbackRollupBound(query.to), {
    message: 'from must be strictly before to',
    path: ['from'],
  })
  .refine(
    query =>
      parseFeedbackRollupBound(query.to).getTime() - parseFeedbackRollupBound(query.from).getTime() <=
      FEEDBACK_ROLLUP_MAX_WINDOW_DAYS * ROLLUP_DAY_MS,
    {
      message: `window must not exceed ${FEEDBACK_ROLLUP_MAX_WINDOW_DAYS} days`,
      path: ['to'],
    }
  );

export type FeedbackRollupQuery = z.infer<typeof FeedbackRollupQuerySchema>;

export interface FeedbackRollupBucket {
  key: string;
  count: number;
}

/** A member named in the report, resolved to something a reader recognizes. */
export interface OrgFeedbackMember {
  userId: string;
  /** `name`, else `username`, else `email`, else the raw id - never blank. */
  displayName: string;
}

export interface OrgFeedbackMemberCount extends OrgFeedbackMember {
  count: number;
}

/**
 * GET /api/organizations/:id/feedback-report. Declared here rather than beside the route so the
 * handler, the aggregate that builds it and the client hook that reads it share one shape.
 *
 * `membership` is not decoration: the report scopes on the UNION of the org ACL and the
 * `Feedback.organizationId` stamp population (see `OrgMemberPopulation`), and those two disagree
 * often enough that a count with no note of the disagreement is a number nobody can check. The
 * one-sided lists say which members were counted on one source's word alone.
 */
export interface OrgFeedbackReport {
  /** The resolved window, echoed back because the route defaults it when the caller omits it. */
  range: { from: string; to: string };
  totals: { count: number };
  byDay: { day: string; count: number }[];
  bySubject: FeedbackCountBucket[];
  byType: FeedbackCountBucket[];
  byStatus: FeedbackCountBucket[];
  /** Rows carrying no tag are absent, so these counts do not sum to `totals.count`. */
  byTag: FeedbackCountBucket[];
  byMember: OrgFeedbackMemberCount[];
  membership: {
    /** Size of the union the report scoped on. */
    memberCount: number;
    /** In the org's ACL, but authoring no org-stamped content. */
    aclOnly: OrgFeedbackMember[];
    /** Authoring org-stamped content, but holding no ACL row. */
    stampOnly: OrgFeedbackMember[];
  };
}

/**
 * One row behind a report cell, as the drill-down returns it.
 *
 * METADATA ONLY, by rule: no feedback text and no `promptMeta`. Verbatim stays reachable only
 * through GET /api/feedback/:id/read, whose CASL check grants it to the reporter or a platform
 * admin - an org owner or manager is neither, and widening that grant is exactly the escalation
 * this report is built to avoid. Anything added here is visible to every org administrator, so
 * the mapper that fills it is an explicit field list rather than a document spread.
 */
export interface OrgFeedbackItem {
  id: string;
  createdAt: string;
  userId: string;
  username: string;
  subject: FeedbackSubject;
  status: FeedbackStatus;
  type?: FeedbackType;
  tags: string[];
  sessionId?: string;
  questId?: string;
  /** Tells "text expired under the 90-day TTL" apart from "this report never had text". */
  contentStored: boolean;
}

/** GET /api/organizations/:id/feedback-report/items - one page of `OrgFeedbackItem`. */
export interface OrgFeedbackItemPage {
  items: OrgFeedbackItem[];
  /** Rows matching the whole window, not just this page - the drill-down paginates. */
  total: number;
  limit: number;
  offset: number;
}
/** One rollup dimension: its top keys by count, and whether keys were dropped to get there. */
export interface FeedbackRollupDimension {
  buckets: FeedbackRollupBucket[];
  truncated: boolean;
}

/**
 * GET /api/feedback/rollup response. Every bucket value is a count over the matched set; nothing
 * here carries report text, an email, or a display name.
 */
export interface FeedbackRollupResponse {
  /** Echoed back as the normalized UTC bounds actually queried, not the raw query strings. */
  from: string;
  to: string;
  total: number;
  topN: number;
  textRetentionDays: number;
  /**
   * Whether the matched reports still have their free text, derived per document from
   * `contentStored` and the retention cutoff. A report that never stored text is in neither arm,
   * since "never had text" and "text expired" are different facts (see IFeedback.contentStored).
   */
  textAvailability: { stored: number; expired: number };
  buckets: {
    sessionId: FeedbackRollupDimension;
    questId: FeedbackRollupDimension;
    subject: FeedbackRollupDimension;
    status: FeedbackRollupDimension;
    tags: FeedbackRollupDimension;
  };
}
