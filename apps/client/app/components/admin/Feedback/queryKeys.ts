/**
 * React Query keys for the admin feedback tab, in one place because three surfaces read the same
 * records and every mutation has to refresh all of them: the paged list, the unfiltered
 * organization facet, and the single record a deep link pins above the list. A mutation that
 * invalidates only the list leaves the focused card showing the pre-mutation status.
 */
export const FEEDBACK_LIST_QUERY_KEY = ['admin', 'feedback', 'list'] as const;
export const FEEDBACK_ORGANIZATIONS_QUERY_KEY = ['admin', 'feedback', 'organizations'] as const;
export const FEEDBACK_RECORD_QUERY_KEY = ['admin', 'feedback', 'record'] as const;

export const feedbackRecordQueryKey = (feedbackId: string) => [...FEEDBACK_RECORD_QUERY_KEY, feedbackId];
