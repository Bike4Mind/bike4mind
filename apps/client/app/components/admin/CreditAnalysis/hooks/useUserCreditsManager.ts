import { useState } from 'react';
import { useGetUsers } from '@client/app/hooks/data/user';
import { api } from '@client/app/contexts/ApiContext';
import type { IGetUsersResponse } from '@client/app/utils/userAPICalls';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';

export function useUserCreditsManager(onRefresh?: () => void) {
  const { value: searchQuery, debouncedValue: debouncedSearch, setValue: setSearchValue } = useDebounceValue('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);

  // Search + sort are pushed to the server so they span the full dataset, not just
  // the current page (issue #883). The API sorts/filters before $skip/$limit, so the
  // returned page is already globally ordered.
  const params = {
    page: currentPage,
    limit: pageSize,
    search: debouncedSearch.trim() || undefined,
    sortField: 'currentCredits',
    sortOrder: sortDirection,
  } as const;
  // Overrides the hook's default fetcher so the request carries exactly `params` (including the server-side sort).
  const allUsers = useGetUsers(params, {
    queryFn: async () => (await api.get<IGetUsersResponse>('/api/users', { params })).data,
  });

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

  const handleRefresh = () => {
    allUsers.refetch();
    onRefresh?.();
  };

  const users = allUsers.data?.users ?? [];

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
    allUsers,
    users,
    handleRefresh,
  };
}
