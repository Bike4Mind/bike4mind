import { FEEDBACK_LIST_MAX_LIMIT, FeedbackSubject } from '@bike4mind/common';

/**
 * Page sizes offered for the feedback list, passed explicitly rather than left to
 * PaginationControls' own defaults: that component is shared with other admin tabs, and a size
 * above FEEDBACK_LIST_MAX_LIMIT is rejected by GET /api/feedback outright. Deriving the top option
 * from the cap means the two cannot drift into a list that 4xxs on its largest page size.
 */
export const FEEDBACK_PAGE_SIZE_OPTIONS = [10, 20, 50, FEEDBACK_LIST_MAX_LIMIT];

/**
 * Sentinel for the subject filter's "no filter" entry. Not a FeedbackSubject, so it cannot collide
 * with a real one, and it exists as a menu entry rather than a placeholder so an operator who
 * picked a subject has a visible way back to all of them.
 */
export const FEEDBACK_SUBJECT_ANY = 'all';

export type FeedbackSubjectOption = FeedbackSubject | typeof FEEDBACK_SUBJECT_ANY;

/**
 * Translates the Select's value back into the filter. The sentinel and a null (Joy hands one back
 * when a Select is cleared) both mean no filter, which the server reads as every subject.
 */
export const toSubjectFilter = (option: FeedbackSubjectOption | null): FeedbackSubject | undefined =>
  option && option !== FEEDBACK_SUBJECT_ANY ? option : undefined;

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
