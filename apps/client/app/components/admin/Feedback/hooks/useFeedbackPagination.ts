import { useCallback } from 'react';
import { UseFeedbackPaginationReturn } from '../types';
import { useFeedbackView } from './useFeedbackView';

/**
 * Page cursor for the feedback list, kept in the URL alongside the filters (see useFeedbackView).
 *
 * Holds only the page and page size: the rows themselves come back already paginated from
 * GET /api/feedback, so there is nothing to slice here. This hook is declared BEFORE the query
 * that consumes it, because its values are query inputs rather than results.
 */
export const useFeedbackPagination = (): UseFeedbackPaginationReturn => {
  const [{ page, limit }, updateView] = useFeedbackView();

  const handlePageChange = useCallback((newPage: number) => updateView({ page: newPage }), [updateView]);

  const handleItemsPerPageChange = useCallback((items: number) => updateView({ limit: items, page: 1 }), [updateView]);

  return { currentPage: page, handlePageChange, itemsPerPage: limit, handleItemsPerPageChange };
};
