import {
  IFeedbackDocument,
  FeedbackStatus,
  FeedbackSubject,
  FeedbackType,
  type FeedbackAiLabels,
} from '@bike4mind/common';
import type { FeedbackCommentFilter, FeedbackView } from './feedbackTabSearch';
import type { FeedbackReceivedWindow } from './feedbackTrends';
import type { FeedbackResolution, UpdateFeedbackStatusRequest } from '@bike4mind/common';

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
  area?: FeedbackAiLabels['area'];
  severity?: FeedbackAiLabels['severity'];
  searchTerm: string;
  statusFilters: Record<FeedbackStatus, boolean>;
  selectedOrganizations: string[];
  /** Undefined is every subject: the server reads an absent `subject` as no filter at all. */
  subject?: FeedbackSubject;
  resolution?: FeedbackResolution;
  /** Empty is every type. */
  types: FeedbackType[];
  /** Undefined is any age. */
  received?: FeedbackReceivedWindow;
  /** `YYYY-MM-DD` viewer-local days, both inclusive. */
  createdFrom?: string;
  createdTo?: string;
  comment?: FeedbackCommentFilter;
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
  area?: FeedbackAiLabels['area'];
  severity?: FeedbackAiLabels['severity'];
  userId?: string;
  sessionId?: string;
  questId?: string;
  organizationId?: string;
  subject?: FeedbackSubject;
  resolution?: FeedbackResolution;
  status?: FeedbackStatus[];
  /** `Feedback` also matches reports with no type (help modal, older reports). */
  type?: FeedbackType[];
  organization?: string[];
  received?: FeedbackReceivedWindow;
  /** ISO instants, both inclusive. */
  createdFrom?: string;
  createdTo?: string;
  hasComment?: boolean;
  search?: string;
  sort: 'asc' | 'desc';
}

export type FeedbackListParams = FeedbackListFilterParams & {
  page: number;
  limit: number;
  /**
   * Ask the server to compute the `organizations` facet. Opt-in because it is a `distinct` over
   * the caller's entire accessible set - for an admin, the whole collection on an unindexed field
   * - and is returned alongside the requested rows. The org filter menu uses `facetsOnly` instead.
   */
  includeOrganizations?: boolean;
  /** Return only the `organizations` facet; the server reads and audits no rows. */
  facetsOnly?: boolean;
};

/** Response envelope of GET /api/feedback. */
export interface FeedbackListResponse {
  items: IExtendedFeedbackDocument[];
  total: number;
  page: number;
  limit: number;
  /**
   * Distinct organization labels across the caller's whole accessible set, for the filter menu.
   * Present only when the request asked for it (`includeOrganizations` or `facetsOnly`).
   */
  organizations?: string[];
}

// Hook return types
export interface UseFeedbackFiltersReturn {
  setArea: (value: FeedbackAiLabels['area'] | undefined) => void;
  setSeverity: (value: FeedbackAiLabels['severity'] | undefined) => void;
  filters: FeedbackFilters;
  setSearchTerm: (term: string) => void;
  setStatusFilters: React.Dispatch<React.SetStateAction<Record<FeedbackStatus, boolean>>>;
  setSelectedOrganizations: (orgs: string[]) => void;
  /** Undefined clears the filter back to every subject. */
  setSubject: (subject: FeedbackSubject | undefined) => void;
  setResolution: (resolution: FeedbackResolution | undefined) => void;
  /** Empty clears the filter back to every type. */
  setTypes: (types: FeedbackType[]) => void;
  /** Undefined clears the filter back to any age. */
  setReceived: (received: FeedbackReceivedWindow | undefined) => void;
  /** Sets a custom created range (clearing any preset window); both undefined clears it. */
  setCreatedRange: (range: { createdFrom: string | undefined; createdTo: string | undefined }) => void;
  /** Undefined clears the filter back to reports with or without a comment. */
  setComment: (comment: FeedbackCommentFilter | undefined) => void;
  /** Replaces every filter with the defaults plus `view`, and clears the search box. */
  showOnly: (view: Partial<Pick<FeedbackView, 'statusFilters' | 'types' | 'received'>>) => void;
  toggleSortDirection: () => void;
  /** Debounced, server-ready filter query. Feeds both the list and the CSV export. */
  filterParams: FeedbackListFilterParams;
}

export interface UseFeedbackPaginationReturn {
  currentPage: number;
  handlePageChange: (newPage: number) => void;
  itemsPerPage: number;
  handleItemsPerPageChange: (items: number) => void;
}

export interface UseFeedbackOperationsReturn {
  /** The current page of results, already filtered and sorted by the server. */
  feedback: IExtendedFeedbackDocument[];
  organizations: string[];
  /** Total matching the current filters across all pages - drives pagination and the CSV count. */
  total: number;
  /** Whether `total` is the answer for the current params rather than a previous query's. */
  totalSettled: boolean;
  loading: boolean;
  /** The list request failed; the table shows a retry in place of the rows. */
  isError: boolean;
  refreshFeedback: () => Promise<void>;
  handleStatusChange: (feedbackItem: IExtendedFeedbackDocument, newValue: FeedbackStatus | null) => Promise<void>;
  feedbackToClose: IExtendedFeedbackDocument | null;
  cancelClose: () => void;
  confirmClose: (
    body: Pick<UpdateFeedbackStatusRequest, 'resolution' | 'resolutionDuplicateId' | 'reason'>
  ) => Promise<void>;
  handleDeleteFeedbackClick: (feedback: IExtendedFeedbackDocument) => void;
  confirmDeleteFeedback: (reason: string) => Promise<void>;
  feedbackToDelete: string | null;
  openDeleteFeedbackModal: boolean;
  toggleDeleteFeedbackModal: () => void;
}
