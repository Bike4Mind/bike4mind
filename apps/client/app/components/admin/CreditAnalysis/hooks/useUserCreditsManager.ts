import { useState } from 'react';
import { useGetUsers } from '@client/app/hooks/data/user';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { getServerErrorField } from '@client/app/utils/error';
import { useUpdateUserCredits } from './useUpdateUserCredits';
import { CreditChange, NotificationState } from '../types';

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

  const users = allUsers.data?.users ?? [];

  // Resolves false on failure (after the error toast) so the modal can stay open with the admin's input.
  const handleCreditAdjustment = async (userId: string, change: CreditChange, note: string): Promise<boolean> => {
    try {
      const updated: { currentCredits?: unknown } | null = await updateUserCreditsMutation.mutateAsync({
        userId,
        // A delta applies atomically against the live balance, so interim spend is not
        // refunded and the balance never goes negative.
        ...(change.kind === 'delta' ? { creditDelta: change.delta } : { currentCredits: change.balance }),
        // The admin's required "Reason for adjustment" - persisted on the audit record.
        note: note.trim(),
      });
      // Report the committed balance: the server floors deductions, so the request is not the outcome.
      const committed = typeof updated?.currentCredits === 'number' ? updated.currentCredits : null;
      const requested =
        change.kind === 'set'
          ? `Requested balance ${change.balance.toLocaleString()}`
          : `Requested ${change.delta > 0 ? '+' : '-'}${Math.abs(change.delta).toLocaleString()} credits`;
      setNotification({
        open: true,
        message: committed === null ? requested : `${requested}; balance is now ${committed.toLocaleString()}`,
        color: 'success',
      });
      handleRefresh();
      return true;
    } catch (error) {
      setNotification({
        open: true,
        message: getServerErrorField(error) || 'Failed to update credits',
        color: 'danger',
      });
      return false;
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
