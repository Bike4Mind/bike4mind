import { useState, useMemo } from 'react';
import { useGetUsers } from '@client/app/hooks/data/user';
import { useUpdateUserCredits } from './useUpdateUserCredits';
import { NotificationState } from '../types';

export function useUserCreditsManager(onRefresh?: () => void) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);
  const [notification, setNotification] = useState<NotificationState>({
    open: false,
    message: '',
    color: 'neutral',
  });

  const allUsers = useGetUsers({ page: currentPage, limit: pageSize });
  const updateUserCreditsMutation = useUpdateUserCredits();

  const toggleSortDirection = () => {
    setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
  };

  const handleRefresh = () => {
    allUsers.refetch();
    onRefresh?.();
  };

  // Filter and sort users
  const filteredAndSortedUsers = useMemo(() => {
    if (!allUsers.data?.users) return [];

    const users = allUsers.data.users as any[];
    let filtered = users;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = users.filter(
        (user: any) =>
          (user.email && user.email.toLowerCase().includes(query)) ||
          (user.fullName && user.fullName.toLowerCase().includes(query))
      );
    }

    return [...filtered].sort((a: any, b: any) => {
      const aCredits = a.currentCredits || 0;
      const bCredits = b.currentCredits || 0;
      return sortDirection === 'asc' ? aCredits - bCredits : bCredits - aCredits;
    });
  }, [allUsers.data?.users, searchQuery, sortDirection]);

  const handleCreditAdjustment = async (userId: string, currentCredits: number, adjustment: number, note?: string) => {
    const newCredits = Math.max(0, currentCredits + adjustment);
    try {
      await updateUserCreditsMutation.mutateAsync({
        userId,
        credits: newCredits,
        // The admin's typed "Reason for adjustment" - persisted on the audit
        // record. Server supplies a default description when this is empty.
        note: note?.trim() || undefined,
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

  // Reset to first page when search changes
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
  };

  // Reset to first page when page size changes
  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setCurrentPage(1);
  };

  // Calculate pagination values from server response
  const totalUsers = allUsers.data?.totalUsers || 0;
  const totalPages = allUsers.data?.totalPages || 0;
  const paginatedUsers = filteredAndSortedUsers;

  return {
    searchQuery,
    setSearchQuery: handleSearchChange,
    sortDirection,
    setSortDirection: (direction: 'asc' | 'desc') => setSortDirection(direction),
    pageSize,
    setPageSize: handlePageSizeChange,
    currentPage,
    setCurrentPage,
    totalPages,
    totalUsers,
    notification,
    setNotification,
    allUsers,
    filteredAndSortedUsers,
    paginatedUsers,
    toggleSortDirection,
    handleRefresh,
    handleCreditAdjustment,
    isLoading: allUsers.isLoading,
    error: allUsers.error,
  };
}
