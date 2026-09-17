import { useCallback, useState } from 'react';
import { FEEDBACK_LIST_DEFAULT_LIMIT } from '@bike4mind/common';
import { UseFeedbackPaginationReturn } from '../types';

/**
 * Page cursor for the feedback list.
 *
 * Holds only the page and page size: the rows themselves come back already paginated from
 * GET /api/feedback, so there is nothing to slice here. This hook is declared BEFORE the query
 * that consumes it, because its values are query inputs rather than results.
 */
export const useFeedbackPagination = (): UseFeedbackPaginationReturn => {
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(FEEDBACK_LIST_DEFAULT_LIMIT);

  const handlePageChange = useCallback((newPage: number) => {
    setCurrentPage(newPage);
  }, []);

  const handleItemsPerPageChange = useCallback((items: number) => {
    setItemsPerPage(items);
    setCurrentPage(1);
  }, []);

  // Filters narrow the result set, so page 7 of the old set may not exist in the new one - which
  // would otherwise show an empty table with no indication why.
  const resetPage = useCallback(() => {
    setCurrentPage(1);
  }, []);

  return { currentPage, handlePageChange, itemsPerPage, handleItemsPerPageChange, resetPage };
};
