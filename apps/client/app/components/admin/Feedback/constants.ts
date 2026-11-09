import { FEEDBACK_LIST_MAX_LIMIT, FEEDBACK_SUBJECTS, FeedbackStatus, FeedbackSubject } from '@bike4mind/common';

/**
 * Page sizes offered for the feedback list. Must match DataTable's page-size select (25, 50, 100),
 * which is the list's only pager; the top size is FEEDBACK_LIST_MAX_LIMIT because GET /api/feedback
 * rejects a larger limit outright, so the two cannot drift into a size that 4xxs.
 */
export const FEEDBACK_PAGE_SIZE_OPTIONS = [25, 50, FEEDBACK_LIST_MAX_LIMIT];

export const FEEDBACK_DEFAULT_PAGE_SIZE = FEEDBACK_PAGE_SIZE_OPTIONS[0];

/** Triage order: the status filter and each row's status select list them in it, and `feedbackStatus` is written in it. */
export const FEEDBACK_STATUS_ORDER = [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed] as const;

/** Sentence-case labels; the stored values are bare tokens (`InProgress`). */
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  [FeedbackStatus.New]: 'New',
  [FeedbackStatus.InProgress]: 'In progress',
  [FeedbackStatus.Closed]: 'Closed',
};

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
