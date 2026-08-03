import FullUserViewModal from '@client/app/components/admin/Users/Views/FullUserViewModal';
import { useGetUsers } from '@client/app/hooks/data/user';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import { Box, LinearProgress, Sheet, Stack } from '@mui/joy';
import React, { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import AdminProfileModal from '../AdminProfileModal';
import ComplianceModal from './ComplianceModal';
import CreateUserModal, { useCreateUserModal } from './CreateUserModal';
import { exportUsersCsv } from './exportUsersCsv';
import MobileFiltersDrawer from './MobileFiltersDrawer';
import PaginationControls from './PaginationControls';
import { PAGE_LIMIT_OPTIONS, useUsersTab } from './useUsersTabParams';
import UsersFilterBar, { UsersDisplayMode } from './UsersFilterBar';
import { FullUsersView } from './Views/FullUsersView';
import RecentActivityView from './Views/RecentActivityView';
import SlimUsersContainer from './Views/SlimUsersView';
import UserJourney from './Views/UserJourney';

const UsersTab: React.FC = () => {
  const isMobile = useIsMobile();
  const [displayMode, setDisplayMode] = useState<UsersDisplayMode>('slim');
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
  const organizations = useGetAllOrganizations({ filters: { personal: false } });
  const { setOpen: setCreateUserModalOpen } = useCreateUserModal();

  const [totalUsers, setTotalUsers] = useState<number>(1);
  const [params, setParams] = useUsersTab(useShallow(state => [state.params, state.setParams]));

  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');

  const usersQuery = useGetUsers(params);
  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data]);

  useEffect(() => {
    setTotalUsers(curr => usersQuery?.data?.totalUsers ?? curr);
  }, [usersQuery?.data?.totalUsers, setTotalUsers]);

  // Reset to "All" if no orgs selected or if selected orgs don't exist in available options
  useEffect(() => {
    if (!params.orgSearch || params.orgSearch.length === 0) {
      setParams({ orgSearch: ['all'] });
      return;
    }

    if (organizations.data && !organizations.isLoading) {
      const availableOrgNames = organizations.data.map(org => org.name);
      const specialValues = ['all', 'Unassigned'];
      const hasValidSelection = params.orgSearch.some(
        selected => specialValues.includes(selected) || availableOrgNames.includes(selected)
      );

      if (!hasValidSelection) {
        setParams({ orgSearch: ['all'] });
      }
    }
  }, [params.orgSearch, organizations.data, organizations.isLoading, setParams]);

  useEffect(() => {
    if (debouncedSearch === params.search) return;
    setParams({ search: debouncedSearch, page: 1 });
  }, [debouncedSearch, params.search, setParams]);

  const loading = useMemo(
    () => usersQuery.isLoading || usersQuery.isFetching,
    [usersQuery.isLoading, usersQuery.isFetching]
  );

  return (
    <Sheet
      sx={{
        overflow: 'hidden',
        width: '100%',
        px: { xs: 1, sm: 2 },
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ flexShrink: 0 }}>
        <Stack sx={{ pt: { xs: 0.5, sm: 1 }, mb: { xs: 0.5, sm: 1 } }}>
          <UsersFilterBar
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
            loading={loading}
            search={search}
            onSearchChange={setSearch}
            onRefresh={() => usersQuery.refetch()}
            onDownloadCsv={() => exportUsersCsv(params)}
            onCreateUser={() => setCreateUserModalOpen(true)}
            downloadDisabled={loading || users.length === 0}
            onOpenFilters={() => setFiltersDrawerOpen(true)}
          />
        </Stack>

        {/* Full pagination lives above the table on desktop; phones get the compact pager only. */}
        {!isMobile && (
          <PaginationControls
            variant="full"
            currentPage={params.page}
            totalPages={usersQuery.data?.totalPages ?? 0}
            onPageChange={page => setParams({ page })}
            currentLimit={params.limit}
            onLimitChange={limit => setParams({ limit, page: 1 })}
            totalUsers={totalUsers}
            pageLimitOptions={PAGE_LIMIT_OPTIONS}
          />
        )}

        {loading && (
          <LinearProgress
            data-testid="admin-users-loading-indicator"
            size={'lg'}
            sx={{ marginX: '5px', width: '100%' }}
          />
        )}
      </Box>

      {!usersQuery.isLoading && (
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', mt: 0.5 }}>
          {displayMode === 'full' &&
            users.map((user, index) => <FullUsersView user={user} index={index} key={user.id} />)}

          {displayMode === 'slim' && <SlimUsersContainer users={users} />}

          {displayMode === 'userJourney' &&
            users.map((user, index) => <UserJourney user={user} index={index} key={user.id} />)}

          {displayMode === 'recentActivity' && <RecentActivityView />}
        </Box>
      )}

      <Box sx={{ flexShrink: 0 }}>
        <PaginationControls
          variant="compact"
          currentPage={params.page}
          totalPages={usersQuery.data?.totalPages ?? 0}
          onPageChange={page => setParams({ page })}
          currentLimit={params.limit}
          onLimitChange={limit => setParams({ limit, page: 1 })}
          totalUsers={totalUsers}
          pageLimitOptions={PAGE_LIMIT_OPTIONS}
        />
      </Box>

      <MobileFiltersDrawer open={filtersDrawerOpen} onClose={() => setFiltersDrawerOpen(false)} loading={loading} />

      {/* Place all modals in one area */}
      <AdminProfileModal />
      <ComplianceModal />
      <FullUserViewModal />
      <CreateUserModal />
    </Sheet>
  );
};

export default UsersTab;
