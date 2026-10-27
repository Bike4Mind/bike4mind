import { useGetUsers } from '@client/app/hooks/data/user';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import { Alert, Box, Checkbox, LinearProgress, Option, Select, Sheet, Stack } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { SignupAnomalySnapshot } from '@client/app/utils/signupAnomaly';
import { AnomalyBanner } from './AnomalyBanner';
import { EmailDomainGroups } from './EmailDomainGroups';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import AdminProfileModal from '../AdminProfileModal';
import BulkAbuseBar from './BulkAbuseBar';
import BulkAbuseResponseModal from './BulkAbuseResponseModal';
import ComplianceModal from './ComplianceModal';
import CreateUserModal, { useCreateUserModal } from './CreateUserModal';
import { exportUsersCsv } from './exportUsersCsv';
import MobileFiltersDrawer from './MobileFiltersDrawer';
import PaginationControls from './PaginationControls';
import { PAGE_LIMIT_OPTIONS, useUsersParams, useUsersTab, useUsersTabUrlSync } from './useUsersTabParams';
import UsersFilterBar from './UsersFilterBar';
import { useShallow } from 'zustand/react/shallow';
import { FullUsersView } from './Views/FullUsersView';
import RecentActivityView from './Views/RecentActivityView';
import SlimUsersContainer, { type UserSelection } from './Views/SlimUsersView';
import UserJourney from './Views/UserJourney';

const UsersTab: React.FC = () => {
  const isMobile = useIsMobile();
  const [displayMode, setDisplayMode] = useUsersTab(
    useShallow(state => [state.displayMode, state.setDisplayMode] as const)
  );
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
  const organizations = useGetAllOrganizations({ filters: { personal: false } });
  const { setOpen: setCreateUserModalOpen } = useCreateUserModal();
  // Kept across pages and searches so a cohort can be built up; cleared after a bulk run.
  const [selectedUserIds, setSelectedUserIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkAbuseOpen, setBulkAbuseOpen] = useState(false);

  const [totalUsers, setTotalUsers] = useState<number>(1);
  useUsersTabUrlSync();
  const [params, setParams] = useUsersParams();

  // Seed from the persisted params so the sync effect below does not wipe a restored search.
  const {
    value: search,
    debouncedValue: debouncedSearch,
    setValue: setSearch,
  } = useDebounceValue(useUsersTab.getState().params.search ?? '');

  const usersQuery = useGetUsers(params);
  const anomalyQuery = useQuery({
    queryKey: ['admin-signup-anomaly'],
    queryFn: async () => (await api.get<SignupAnomalySnapshot>('/api/admin/signup-anomaly')).data,
    staleTime: 60000,
    refetchInterval: 60000,
  });
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

  const selection = useMemo<UserSelection>(
    () => ({
      selectedIds: selectedUserIds,
      onToggle: userId =>
        setSelectedUserIds(current => {
          const next = new Set(current);
          if (!next.delete(userId)) next.add(userId);
          return next;
        }),
      onTogglePage: (userIds, selected) =>
        setSelectedUserIds(current => {
          const next = new Set(current);
          userIds.forEach(userId => (selected ? next.add(userId) : next.delete(userId)));
          return next;
        }),
    }),
    [selectedUserIds]
  );
  const clearSelection = useCallback(() => setSelectedUserIds(new Set()), []);

  const handleDownloadCsv = useCallback(async () => {
    try {
      await exportUsersCsv(params);
    } catch (err) {
      console.error('Failed to export users CSV:', err);
      toast.error('Failed to download the user CSV.');
    }
  }, [params]);

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
          <AnomalyBanner
            snapshot={anomalyQuery.data}
            onReview={() => {
              setSearch('');
              setParams({
                recentSignups: 'hour',
                groupBy: 'emailDomain',
                page: 1,
                search: '',
                orgSearch: ['all'],
                tags: [],
              });
            }}
          />
          {anomalyQuery.isError && <Alert color="warning">Could not check signup anomalies. Refresh to retry.</Alert>}
          <Stack direction="row" gap={2} flexWrap="wrap" sx={{ my: 1 }}>
            <Select
              aria-label="Group by"
              data-testid="users-group-by"
              value={params.groupBy ?? 'none'}
              onChange={(_, value) =>
                setParams({ groupBy: value === 'emailDomain' ? 'emailDomain' : undefined, page: 1 })
              }
            >
              <Option value="none">Group by: None</Option>
              <Option value="emailDomain">Group by: Email domain</Option>
            </Select>
            <Checkbox
              label="Signed up in the last hour"
              checked={params.recentSignups === 'hour'}
              slotProps={{ input: { 'data-testid': 'users-recent-signups-filter' } }}
              onChange={event => setParams({ recentSignups: event.target.checked ? 'hour' : undefined, page: 1 })}
            />
          </Stack>
          <UsersFilterBar
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
            loading={loading}
            search={search}
            onSearchChange={setSearch}
            onRefresh={() => {
              usersQuery.refetch();
              anomalyQuery.refetch();
            }}
            onDownloadCsv={handleDownloadCsv}
            onCreateUser={() => setCreateUserModalOpen(true)}
            downloadDisabled={loading || users.length === 0}
            onOpenFilters={() => setFiltersDrawerOpen(true)}
          />
          <BulkAbuseBar
            selectedCount={params.groupBy || displayMode === 'slim' ? selectedUserIds.size : 0}
            onClearSelection={clearSelection}
            onOpen={() => setBulkAbuseOpen(true)}
          />
        </Stack>

        {/* Full pagination lives above the table on desktop; phones get the compact pager only. */}
        {!isMobile && !params.groupBy && (
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

      {(params.groupBy || !usersQuery.isLoading) && (
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', mt: 0.5 }}>
          {params.groupBy && (
            <EmailDomainGroups
              groups={usersQuery.data?.groups ?? []}
              selection={selection}
              loading={loading}
              error={usersQuery.isError ? 'Could not load domain groups. Retry the request.' : undefined}
              onRetry={() => usersQuery.refetch()}
              truncated={usersQuery.data?.groupsTruncated}
              keysTruncated={usersQuery.data?.keysTruncated}
            />
          )}
          {!params.groupBy &&
            displayMode === 'full' &&
            users.map((user, index) => <FullUsersView user={user} index={index} key={user.id} />)}

          {!params.groupBy && displayMode === 'slim' && <SlimUsersContainer users={users} selection={selection} />}

          {!params.groupBy &&
            displayMode === 'userJourney' &&
            users.map((user, index) => <UserJourney user={user} index={index} key={user.id} />)}

          {!params.groupBy && displayMode === 'recentActivity' && <RecentActivityView />}
        </Box>
      )}

      <Box sx={{ flexShrink: 0, display: params.groupBy ? 'none' : undefined }}>
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

      {/* Mobile-only: nothing opens this on desktop, since the filter toggle is mobile-only. */}
      {isMobile && (
        <MobileFiltersDrawer open={filtersDrawerOpen} onClose={() => setFiltersDrawerOpen(false)} loading={loading} />
      )}

      {/* Place all modals in one area */}
      <AdminProfileModal />
      <ComplianceModal />
      <CreateUserModal />
      {/* Mounted only while open, so each run starts from a clean form. */}
      {bulkAbuseOpen && (
        <BulkAbuseResponseModal
          selectedUserIds={params.groupBy || displayMode === 'slim' ? [...selectedUserIds] : []}
          onClose={() => setBulkAbuseOpen(false)}
          onExecuted={clearSelection}
        />
      )}
    </Sheet>
  );
};

export default UsersTab;
