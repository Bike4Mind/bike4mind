import { useState, useMemo } from 'react';
import { IExtendedFeedbackDocument, UseFeedbackPaginationReturn } from '../types';

export const useFeedbackPagination = (
  filteredAndSortedFeedback: IExtendedFeedbackDocument[]
): UseFeedbackPaginationReturn => {
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);

  const totalPages = Math.ceil(filteredAndSortedFeedback.length / itemsPerPage);

  const currentFeedback = useMemo(() => {
    const indexOfLast = currentPage * itemsPerPage;
    const indexOfFirst = indexOfLast - itemsPerPage;
    return filteredAndSortedFeedback.slice(indexOfFirst, indexOfLast);
  }, [filteredAndSortedFeedback, currentPage, itemsPerPage]);

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
  };

  const handleItemsPerPageChange = (items: number) => {
    setItemsPerPage(items);
    setCurrentPage(1);
  };

  return {
    currentPage,
    setCurrentPage,
    currentFeedback,
    totalPages,
    handlePageChange,
    itemsPerPage,
    handleItemsPerPageChange,
  };
};
