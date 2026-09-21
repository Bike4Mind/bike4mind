import { IFeedbackDocument, FeedbackStatus, FeedbackSubject } from '@bike4mind/common';

// Extended feedback document with MongoDB _id field. `contentExpired` is added by the API's
// hydrateFeedbackText join - true when content was submitted but has since aged out under the
// 90-day TTL, distinct from a report that never had content at all (both render `content` as
// undefined, so the UI needs this flag to tell them apart). `contentTruncated` is true when the
// original submission was cut at FEEDBACK_CONTENT_MAX_CHARS - without surfacing it, a truncated
// report reads back identically to a short one.
export interface IExtendedFeedbackDocument extends IFeedbackDocument {
  _id: string;
  contentExpired?: boolean;
  contentTruncated?: boolean;
}

/** Renders the same expired/never-had-content distinction everywhere a feedback item's content
 * is displayed - `fallback` covers the "never had content" case, since callers want different
 * copy for it (a blank CSV cell vs. a "No content" toast). */
export function getFeedbackDisplayContent(
  feedbackItem: Pick<IExtendedFeedbackDocument, 'content' | 'contentExpired'> | undefined,
  fallback: string
): string {
  if (!feedbackItem) return fallback;
  return feedbackItem.content ?? (feedbackItem.contentExpired ? '[content expired]' : fallback);
}

export interface FeedbackFilters {
  searchTerm: string;
  statusFilters: Record<FeedbackStatus, boolean>;
  selectedOrganizations: string[];
  /** Undefined is every subject: the server reads an absent `subject` as no filter at all. */
  subject?: FeedbackSubject;
  sortAscending: boolean;
}

/**
 * The filter half of the server query, as GET /api/feedback understands it. Kept separate from
 * page/limit so a CSV export can reuse the same filters while paging independently.
 *
 * `sessionId`/`questId`/`userId`/`organizationId` mirror query params the admin triage table does
 * not use but the endpoint has always accepted (see ListFeedbackQuerySchema) - added for the
 * session-scoped "Reported" annotation read (hooks/data/feedback.ts), which is a second consumer
 * of this same contract rather than a reason to fork a parallel params type. `subject` started out
 * in that group and is now also the triage table's own subject filter.
 */
export interface FeedbackListFilterParams {
  userId?: string;
  sessionId?: string;
  questId?: string;
  organizationId?: string;
  subject?: FeedbackSubject;
  status?: FeedbackStatus[];
  organization?: string[];
  search?: string;
  sort: 'asc' | 'desc';
}

export type FeedbackListParams = FeedbackListFilterParams & {
  page: number;
  limit: number;
  /**
   * Ask the server to compute the `organizations` facet. Opt-in because it is a `distinct` over
   * the caller's entire accessible set - for an admin, the whole collection on an unindexed field
   * - and only the org filter menu's dedicated query consumes it.
   */
  includeOrganizations?: boolean;
};

/** Response envelope of GET /api/feedback. */
export interface FeedbackListResponse {
  items: IExtendedFeedbackDocument[];
  total: number;
  page: number;
  limit: number;
  /**
   * Distinct organization labels across the caller's whole accessible set, for the filter menu.
   * Present only when the request asked for it (`includeOrganizations`).
   */
  organizations?: string[];
}

// Hook return types
export interface UseFeedbackFiltersReturn {
  filters: FeedbackFilters;
  setSearchTerm: (term: string) => void;
  setStatusFilters: React.Dispatch<React.SetStateAction<Record<FeedbackStatus, boolean>>>;
  setSelectedOrganizations: (orgs: string[]) => void;
  /** Undefined clears the filter back to every subject. */
  setSubject: (subject: FeedbackSubject | undefined) => void;
  toggleSortDirection: () => void;
  /** Debounced, server-ready filter query. Feeds both the list and the CSV export. */
  filterParams: FeedbackListFilterParams;
}

export interface UseFeedbackPaginationReturn {
  currentPage: number;
  handlePageChange: (newPage: number) => void;
  itemsPerPage: number;
  handleItemsPerPageChange: (items: number) => void;
  /** Called when a filter changes: the current page number may not exist in the new result set. */
  resetPage: () => void;
}

export interface UseFeedbackOperationsReturn {
  /** The current page of results, already filtered and sorted by the server. */
  feedback: IExtendedFeedbackDocument[];
  organizations: string[];
  /** Total matching the current filters across all pages - drives pagination and the CSV count. */
  total: number;
  loading: boolean;
  refreshFeedback: () => Promise<void>;
  handleStatusChange: (feedbackItem: IExtendedFeedbackDocument, newValue: FeedbackStatus | null) => Promise<void>;
  handleDeleteFeedbackClick: (feedback: IExtendedFeedbackDocument) => void;
  confirmDeleteFeedback: () => Promise<void>;
  feedbackToDelete: string | null;
  openDeleteFeedbackModal: boolean;
  toggleDeleteFeedbackModal: () => void;
}
