import { FEEDBACK_LIST_MAX_LIMIT } from '@bike4mind/common';

/**
 * Page sizes offered for the feedback list, passed explicitly rather than left to
 * PaginationControls' own defaults: that component is shared with other admin tabs, and a size
 * above FEEDBACK_LIST_MAX_LIMIT is rejected by GET /api/feedback outright. Deriving the top option
 * from the cap means the two cannot drift into a list that 4xxs on its largest page size.
 */
export const FEEDBACK_PAGE_SIZE_OPTIONS = [10, 20, 50, FEEDBACK_LIST_MAX_LIMIT];
