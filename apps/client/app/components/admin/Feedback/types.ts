import { IFeedbackDocument, FeedbackStatus } from '@bike4mind/common';

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
  sortAscending: boolean;
}

/**
 * The filter half of the server query, as GET /api/feedback understands it. Kept separate from
 * page/limit so a CSV export can reuse the same filters while paging independently.
 */
export interface FeedbackListFilterParams {
  status?: FeedbackStatus[];
  organization?: string[];
  search?: string;
  sort: 'asc' | 'desc';
}

export type FeedbackListParams = FeedbackListFilterParams & {
  page: number;
  limit: number;
};

/** Response envelope of GET /api/feedback. */
export interface FeedbackListResponse {
  items: IExtendedFeedbackDocument[];
  total: number;
  page: number;
  limit: number;
  /** Distinct organization labels across the caller's whole accessible set, for the filter menu. */
  organizations: string[];
}

// Hook return types
export interface UseFeedbackFiltersReturn {
  filters: FeedbackFilters;
  setSearchTerm: (term: string) => void;
  setStatusFilters: React.Dispatch<React.SetStateAction<Record<FeedbackStatus, boolean>>>;
  setSelectedOrganizations: (orgs: string[]) => void;
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
