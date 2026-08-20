import { IFeedbackDocument, FeedbackStatus } from '@bike4mind/common';

// Extended feedback document with MongoDB _id field. `contentExpired` is added by the API's
// hydrateFeedbackText join - true when content was submitted but has since aged out under the
// 90-day TTL, distinct from a report that never had content at all (both render `content` as
// undefined, so the UI needs this flag to tell them apart).
export interface IExtendedFeedbackDocument extends IFeedbackDocument {
  _id: string;
  contentExpired?: boolean;
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

export interface FeedbackState {
  feedback: IExtendedFeedbackDocument[];
  organizations: string[];
  loading: boolean;
  currentPage: number;
  feedbackToDelete: string | null;
  openDeleteFeedbackModal: boolean;
}

// Hook return types
export interface UseFeedbackFiltersReturn {
  filters: FeedbackFilters;
  setSearchTerm: (term: string) => void;
  setStatusFilters: React.Dispatch<React.SetStateAction<Record<FeedbackStatus, boolean>>>;
  setSelectedOrganizations: (orgs: string[]) => void;
  toggleSortDirection: () => void;
  filteredAndSortedFeedback: IExtendedFeedbackDocument[];
}

export interface UseFeedbackPaginationReturn {
  currentPage: number;
  setCurrentPage: (page: number) => void;
  currentFeedback: IExtendedFeedbackDocument[];
  totalPages: number;
  handlePageChange: (newPage: number) => void;
  itemsPerPage: number;
  handleItemsPerPageChange: (items: number) => void;
}

export interface UseFeedbackOperationsReturn {
  feedback: IExtendedFeedbackDocument[];
  organizations: string[];
  loading: boolean;
  refreshFeedback: () => Promise<void>;
  handleStatusChange: (feedbackItem: IExtendedFeedbackDocument, newValue: FeedbackStatus | null) => Promise<void>;
  handleDeleteFeedbackClick: (feedback: IExtendedFeedbackDocument) => void;
  confirmDeleteFeedback: () => Promise<void>;
  feedbackToDelete: string | null;
  openDeleteFeedbackModal: boolean;
  toggleDeleteFeedbackModal: () => void;
}
