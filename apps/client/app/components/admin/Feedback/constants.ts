import { FEEDBACK_SUBJECTS, FeedbackStatus, FeedbackSubject, FeedbackType } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { ADMIN_PAGE_SIZES } from '../shared/adminStyles';

/**
 * Page sizes offered for the feedback list: the DataTable footer's, its only pager. Read from the
 * React-free adminStyles.ts because the router imports this file eagerly through feedbackTabSearch.ts.
 * GET /api/feedback rejects a limit above FEEDBACK_LIST_MAX_LIMIT outright (constants.test.ts pins it).
 */
export const FEEDBACK_PAGE_SIZE_OPTIONS: readonly number[] = ADMIN_PAGE_SIZES;

export const FEEDBACK_DEFAULT_PAGE_SIZE = FEEDBACK_PAGE_SIZE_OPTIONS[0];

/**
 * Triage order: the status filter and each row's status select list statuses in it, and
 * `feedbackStatus` is written in it.
 */
export const FEEDBACK_STATUS_ORDER = [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed] as const;

/** Sentence-case labels; the stored values are bare tokens (`InProgress`). */
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  [FeedbackStatus.New]: 'New',
  [FeedbackStatus.InProgress]: 'In progress',
  [FeedbackStatus.Closed]: 'Closed',
};

/** Severity order: the type filter and its URL param list types in it. */
export const FEEDBACK_TYPE_ORDER = [
  FeedbackType.BUG,
  FeedbackType.THUMBS_DOWN,
  FeedbackType.FEEDBACK,
  FeedbackType.THUMBS_UP,
] as const;

export const FEEDBACK_TYPE_LABELS: Record<FeedbackType, string> = {
  [FeedbackType.BUG]: 'Bug',
  [FeedbackType.THUMBS_DOWN]: 'Thumbs down',
  [FeedbackType.FEEDBACK]: 'Feedback',
  [FeedbackType.THUMBS_UP]: 'Thumbs up',
};

export const FEEDBACK_TYPE_TONES: Record<FeedbackType, AdminStatusTone> = {
  [FeedbackType.BUG]: 'bad',
  [FeedbackType.THUMBS_DOWN]: 'warn',
  [FeedbackType.FEEDBACK]: 'neutral',
  [FeedbackType.THUMBS_UP]: 'good',
};

/**
 * The type a report is shown as. Reports from the help modal (and older ones) carry no type, and
 * GET /api/feedback's `type=Feedback` filter matches them, so they read as Feedback here too.
 */
export const feedbackTypeOf = (type: string | undefined): FeedbackType =>
  FEEDBACK_TYPE_ORDER.find(known => known === type) ?? FeedbackType.FEEDBACK;

/**
 * Translates the subject filter chip's value back into the filter. Clearing the chip hands back
 * undefined, which the server reads as every subject; a value that is not a subject means the same,
 * so nothing the server does not know is ever sent as a filter.
 */
export const toSubjectFilter = (value: string | undefined): FeedbackSubject | undefined =>
  FEEDBACK_SUBJECTS.find(subject => subject === value);

/**
 * Operator-facing name for each subject, which is stored as a bare lowercase token. The wording
 * matches FEEDBACK_LINK_LABELS (server/utils/feedbackDeepLinks.ts) so a report triaged from the
 * console and one triaged from Slack or email name the same target the same way. 'help' covers
 * both help surfaces, which the row-level HelpContextChip already tells apart.
 *
 * Exhaustive over FeedbackSubject deliberately: a value added to FEEDBACK_SUBJECTS must fail
 * typecheck here rather than reach the filter menu as its raw enum string.
 */
export const FEEDBACK_SUBJECT_LABELS: Record<FeedbackSubject, string> = {
  turn: 'Conversation turn',
  session: 'Conversation',
  product: 'Product',
  help: 'Help',
};
