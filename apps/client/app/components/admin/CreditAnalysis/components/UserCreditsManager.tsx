import React, { useEffect, useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { adminAuditLogPath } from '@bike4mind/common';
import { useGetUser } from '@client/app/hooks/data/user';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { AdminPageHeader, DataTable, EmptyState, FilterBar } from '../../shared';
import { AdjustCreditsDialog } from '../../Users/Profile/actions/AdjustCreditsDialog';
import { useOpenUserProfile } from '../../Users/Profile/useOpenUserProfile';
import { useUserCreditsManager } from '../hooks/useUserCreditsManager';

interface UserCreditsManagerProps {
  onRefresh?: () => void;
}

const ACTIVE_WITHIN_DAYS = 30;

const getLastLoginDate = (user: AdminUserListItem): Date | null => {
  const latest = user.loginRecords?.reduce<string | Date | undefined>((acc, record) => {
    const t = record?.loginTime;
    if (!t) return acc;
    return !acc || new Date(t) > new Date(acc) ? t : acc;
  }, undefined);
  const source = latest ?? user.lastActiveAt;
  return source ? new Date(source) : null;
};

const getActivityStatus = (user: AdminUserListItem): string => {
  if (user.isOnline) return 'Online';
  if (user.lastActiveAt && (Date.now() - new Date(user.lastActiveAt).getTime()) / 86_400_000 <= ACTIVE_WITHIN_DAYS)
    return 'Active';
  return 'Inactive';
};

export const UserCreditsManager: React.FC<UserCreditsManagerProps> = ({ onRefresh }) => {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const selectedUser = useGetUser(selectedUserId);
  const openUserProfile = useOpenUserProfile();
  const navigate = useNavigate();

  const {
    searchQuery,
    setSearchQuery,
    sortDirection,
    setSortDirection,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalUsers,
    users,
    allUsers,
    handleRefresh,
  } = useUserCreditsManager(onRefresh);

  useEffect(() => {
    if (!allUsers.isFetching && allUsers.data && currentPage > Math.max(1, allUsers.data.totalPages)) {
      setCurrentPage(Math.max(1, allUsers.data.totalPages));
    }
  }, [allUsers.data, allUsers.isFetching, currentPage, setCurrentPage]);

  const openAudit = () => {
    setSelectedUserId(null);
    const search = Object.fromEntries(new URL(adminAuditLogPath({ category: 'credits' }), 'http://local').searchParams);
    void navigate({ to: '/admin', search: search as never });
  };

  return (
    <Stack gap={3} data-testid="user-credits-manager">
      <AdminPageHeader
        level="section"
        title="User credits"
        count={allUsers.error ? undefined : totalUsers}
        description="Find a user, review their balance and adjust credits."
        actions={
          <Button
            variant="outlined"
            onClick={handleRefresh}
            disabled={allUsers.isFetching}
            data-testid="credits-refresh-btn"
          >
            Refresh users
          </Button>
        }
      />
      <FilterBar
        state={{ query: searchQuery, view: '', filters: { order: sortDirection } }}
        searchLabel="Search users by name or email"
        filters={[
          {
            id: 'order',
            label: 'Credits',
            options: [
              { value: 'desc', label: 'Highest first' },
              { value: 'asc', label: 'Lowest first' },
            ],
          },
        ]}
        onChange={patch => {
          if (patch.query !== undefined) setSearchQuery(patch.query);
          if (patch.filters?.order) setSortDirection(patch.filters.order === 'asc' ? 'asc' : 'desc');
        }}
      />
      <DataTable
        label="User credits"
        testId="user-credits-table"
        rows={users}
        getRowId={user => user.id}
        loading={allUsers.isLoading || allUsers.isFetching}
        error={allUsers.error ? 'Could not load user credits.' : undefined}
        onRetry={handleRefresh}
        pagination={{
          page: currentPage,
          pageSize,
          total: totalUsers,
          onPageChange: setCurrentPage,
          onPageSizeChange: setPageSize,
        }}
        empty={
          <EmptyState
            title={searchQuery ? 'No users match this search' : 'No users found'}
            description={searchQuery ? 'Try another name or email.' : undefined}
            action={
              <Button variant="outlined" onClick={searchQuery ? () => setSearchQuery('') : handleRefresh}>
                {searchQuery ? 'Clear search' : 'Refresh users'}
              </Button>
            }
          />
        }
        columns={[
          {
            id: 'user',
            label: 'User',
            render: user => (
              <Stack gap={0.25}>
                <Typography level="body-sm">{user.name || 'No name'}</Typography>
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                  {user.email || 'No email'}
                </Typography>
              </Stack>
            ),
          },
          {
            id: 'credits',
            label: 'Credits',
            numeric: true,
            render: user => (user.currentCredits ?? 0).toLocaleString(),
          },
          { id: 'login', label: 'Last login', render: user => getLastLoginDate(user)?.toLocaleDateString() ?? 'Never' },
          {
            id: 'status',
            label: 'Status',
            render: user => (
              <Stack gap={0.25}>
                <Typography level="body-sm">{getActivityStatus(user)}</Typography>
                {user.isAdmin && <Typography level="body-xs">Admin</Typography>}
              </Stack>
            ),
          },
          { id: 'created', label: 'Created', render: user => new Date(user.createdAt).toLocaleDateString() },
          {
            id: 'actions',
            label: 'Actions',
            render: user => (
              <Stack direction="row" gap={1} flexWrap="wrap">
                <Button size="sm" variant="outlined" color="neutral" onClick={() => void openUserProfile(user.id)}>
                  View
                </Button>
                <Button size="sm" variant="outlined" onClick={() => setSelectedUserId(user.id)}>
                  Adjust credits
                </Button>
              </Stack>
            ),
          },
        ]}
      />
      {selectedUserId && selectedUser.isLoading && <Typography role="status">Loading current balance...</Typography>}
      {selectedUserId && selectedUser.error && (
        <Stack direction="row" gap={1} alignItems="center" role="alert">
          <Typography>Could not load the current balance.</Typography>
          <Button onClick={() => void selectedUser.refetch()}>Retry</Button>
          <Button variant="plain" onClick={() => setSelectedUserId(null)}>
            Cancel
          </Button>
        </Stack>
      )}
      {selectedUserId && !selectedUser.error && selectedUser.data && (
        <AdjustCreditsDialog
          key={selectedUserId}
          user={selectedUser.data}
          onClose={() => setSelectedUserId(null)}
          onAudit={openAudit}
        />
      )}
    </Stack>
  );
};
