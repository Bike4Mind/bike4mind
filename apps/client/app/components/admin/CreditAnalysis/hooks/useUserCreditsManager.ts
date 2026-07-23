import { useState } from 'react';
import { useGetUsers } from '@client/app/hooks/data/user';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { useUpdateUserCredits } from './useUpdateUserCredits';
import { NotificationState } from '../types';

export function useUserCreditsManager(onRefresh?: () => void) {
  const { value: searchQuery, debouncedValue: debouncedSearch, setValue: setSearchValue } = useDebounceValue('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);
  const [notification, setNotification] = useState<NotificationState>({
    open: false,
    message: '',
    color: 'neutral',
  });

  // Search + sort are pushed to the server so they span the full dataset, not just
  // the current page (issue #883). The API sorts/filters before $skip/$limit, so the
  // returned page is already globally ordered.
  const allUsers = useGetUsers({
    page: currentPage,
    limit: pageSize,
    search: debouncedSearch.trim() || undefined,
    sortField: 'currentCredits',
    sortOrder: sortDirection,
  });
  const updateUserCreditsMutation = useUpdateUserCredits();

  // A new search or sort produces a different result set, so return to page 1 rather
  // than stranding the user on a page index that may no longer exist.
  const handleSearchChange = (query: string) => {
    setSearchValue(query);
    setCurrentPage(1);
  };

  const handleSortDirectionChange = (direction: 'asc' | 'desc') => {
    setSortDirection(direction);
    setCurrentPage(1);
  };

  const toggleSortDirection = () => {
    handleSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc');
  };

  const handleRefresh = () => {
    allUsers.refetch();
    onRefresh?.();
  };

  const users = (allUsers.data?.users ?? []) as any[];

  const handleCreditAdjustment = async (userId: string, currentCredits: number, adjustment: number) => {
    const newCredits = Math.max(0, currentCredits + adjustment);
    try {
      await updateUserCreditsMutation.mutateAsync({
        userId,
        credits: newCredits,
        note: `${adjustment > 0 ? '+' : ''}${adjustment} credits`,
      });
      setNotification({
        open: true,
        message: `Successfully ${adjustment > 0 ? 'added' : 'removed'} ${Math.abs(adjustment)} credits`,
        color: 'success',
      });
      handleRefresh();
    } catch (error) {
      setNotification({
        open: true,
        message: 'Failed to update credits',
        color: 'danger',
      });
    }
  };

  // Reset to first page when page size changes
  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setCurrentPage(1);
  };

  // Calculate pagination values from server response
  const totalUsers = allUsers.data?.totalUsers || 0;
  const totalPages = allUsers.data?.totalPages || 0;

  return {
    searchQuery,
    setSearchQuery: handleSearchChange,
    sortDirection,
    setSortDirection: handleSortDirectionChange,
    pageSize,
    setPageSize: handlePageSizeChange,
    currentPage,
    setCurrentPage,
    totalPages,
    totalUsers,
    notification,
    setNotification,
    allUsers,
    filteredAndSortedUsers: users,
    paginatedUsers: users,
    toggleSortDirection,
    handleRefresh,
    handleCreditAdjustment,
    isLoading: allUsers.isLoading,
    error: allUsers.error,
  };
}
