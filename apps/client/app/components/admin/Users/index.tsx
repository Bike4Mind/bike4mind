import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Dropdown, IconButton, Menu, MenuButton, MenuItem, Stack } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import DownloadIcon from '@mui/icons-material/Download';
import HistoryIcon from '@mui/icons-material/History';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import type { AdminUsersListRow } from '@client/app/utils/adminUsersFilter';
import type { AdminUsersBulkActionType, AdminUsersBulkTarget } from '@client/app/utils/adminUsersBulk';
import type { SignupAnomalySnapshot } from '@client/app/utils/signupAnomaly';
import type { SignupTimeseriesRange } from '@client/app/utils/signupSignals';
import AdminProfileModal from '../AdminProfileModal';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  type AdminSelection,
  type DataTableGroup,
  type DataTableSort,
} from '../shared';
import { adminFocus } from '../shared/adminStyles';
import { AnomalyBanner } from './AnomalyBanner';
import { SignupActivityPanel } from '../Signups/SignupActivityPanel';
import { useSignupVerdicts } from '../Signups/useSignupTimeseries';
import ComplianceModal from './ComplianceModal';
import CreateUserModal, { useCreateUserModal } from './CreateUserModal';
import { exportUsersCsv } from './exportUsersCsv';
import { DomainGroupHeader } from './List/DomainGroupHeader';
import { UsersBulkActionDialog } from './List/UsersBulkActionDialog';
import { UsersBulkBar } from './List/UsersBulkBar';
import {
  toAdminUsersFilter,
  useAdminUsersDomainGroups,
  useAdminUsersList,
  useAdminUsersSummary,
} from './List/useAdminUsersList';
import { USERS_SORT_COLUMNS, usersColumns } from './List/usersColumns';
import { UsersToolbar } from './List/UsersToolbar';
import { UsersViewTabs } from './List/UsersViewTabs';
import { useOpenUserProfile } from './Profile/useOpenUserProfile';
import { CLEARED_FILTER_PARAMS, countActiveFilters } from './usersTabSearch';
import { useUsersParams, useUsersTab, useUsersTabUrlSync } from './useUsersTabParams';
import RecentActivityView from './Views/RecentActivityView';

const NO_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };

const copyToClipboard = async (value: string, what: string) => {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}.`);
  }
};

function UserRowActions({ row, onOpen }: { row: AdminUsersListRow; onOpen: () => void }) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            'aria-label': `Actions for ${row.name || row.email}`,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        data-testid={`admin-users-row-actions-${row.id}`}
        // The row opens the profile on click; the menu must not.
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }} onClick={event => event.stopPropagation()}>
        <MenuItem onClick={onOpen} data-testid={`admin-users-row-open-${row.id}`}>
          Open profile
        </MenuItem>
        <MenuItem onClick={() => copyToClipboard(row.id, 'User ID')}>Copy user ID</MenuItem>
        {row.email && <MenuItem onClick={() => copyToClipboard(row.email ?? '', 'Email')}>Copy email</MenuItem>}
      </Menu>
    </Dropdown>
  );
}

const UsersTab: React.FC = () => {
  useUsersTabUrlSync();
  const [params, setParams] = useUsersParams();
  const openProfile = useOpenUserProfile();
  const { setOpen: setCreateUserModalOpen } = useCreateUserModal();
  const [showRecentActivity, setShowRecentActivity] = useState(false);
  const [selection, setSelection] = useState<AdminSelection>(NO_SELECTION);
  // The target is frozen when the dialog opens, so a list refetch cannot change what it acts on.
  const [bulkRun, setBulkRun] = useState<{ type: AdminUsersBulkActionType; target: AdminUsersBulkTarget } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [signupRange, setSignupRange] = useState<SignupTimeseriesRange>('7d');

  // Seeded from the persisted params so a restored search is not wiped on mount.
  const {
    value: search,
    debouncedValue: debouncedSearch,
    setValue: setSearch,
  } = useDebounceValue(useUsersTab.getState().params.search ?? '');
  useEffect(() => {
    if (debouncedSearch === params.search) return;
    setParams({ search: debouncedSearch, page: 1 });
  }, [debouncedSearch, params.search, setParams]);

  const usersQuery = useAdminUsersList(params);
  const groupsQuery = useAdminUsersDomainGroups(params);
  const summaryQuery = useAdminUsersSummary();
  const anomalyQuery = useQuery({
    queryKey: ['admin-signup-anomaly'],
    queryFn: async () => (await api.get<SignupAnomalySnapshot>('/api/admin/signup-anomaly')).data,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data]);
  const totalUsers = usersQuery.data?.totalUsers ?? 0;
  const rowIds = useMemo(() => rows.map(row => row.id), [rows]);
  const verdictsQuery = useSignupVerdicts(signupRange, rowIds);
  const verdicts = verdictsQuery.data?.verdicts;
  const columns = useMemo(
    () =>
      usersColumns({
        now: new Date(),
        maxSpend: Math.max(0, ...rows.map(row => row.spend30d ?? 0)),
        verdict: { range: signupRange, verdicts },
      }),
    [rows, signupRange, verdicts]
  );

  // A selection made under one filter must not ride into a bulk run under another.
  const filterKey = JSON.stringify(toAdminUsersFilter(params)) + (params.groupBy ?? '');
  const [selectionFilterKey, setSelectionFilterKey] = useState(filterKey);
  if (selectionFilterKey !== filterKey) {
    setSelectionFilterKey(filterKey);
    setSelection(NO_SELECTION);
  }
  // keepPreviousData leaves the old filter's rows tickable until the new page lands; drop those too.
  const [settledFilterKey, setSettledFilterKey] = useState(filterKey);
  if (!usersQuery.isPlaceholderData && settledFilterKey !== filterKey) {
    setSettledFilterKey(filterKey);
    setSelection(NO_SELECTION);
  }
  const clearSelection = useCallback(() => setSelection(NO_SELECTION), []);
  const openBulkAction = (type: AdminUsersBulkActionType) =>
    setBulkRun({
      type,
      target:
        selection.mode === 'allMatching'
          ? { kind: 'filter', filter: toAdminUsersFilter(params) }
          : { kind: 'ids', userIds: [...selection.ids] },
    });

  const sortColumn = Object.entries(USERS_SORT_COLUMNS).find(([, field]) => field === params.sortField)?.[0];
  const sort: DataTableSort | undefined = sortColumn
    ? { columnId: sortColumn, direction: params.sortOrder }
    : undefined;
  const onSortChange = (next: DataTableSort) => {
    const sortField = USERS_SORT_COLUMNS[next.columnId];
    if (sortField) setParams({ sortField, sortOrder: next.direction, page: 1 });
  };

  const groups = useMemo<DataTableGroup[] | undefined>(() => {
    if (params.groupBy !== 'emailDomain') return undefined;
    return (groupsQuery.data?.groups ?? []).map(group => ({
      id: group.domain,
      rowIds: group.userIds,
      header: (
        <DomainGroupHeader
          group={group}
          filtered={params.emailDomain === group.domain}
          onFilter={() => setParams({ emailDomain: group.domain, page: 1 })}
        />
      ),
    }));
  }, [params.groupBy, params.emailDomain, groupsQuery.data, setParams]);

  const hasFilters = countActiveFilters(params) > 0 || params.search.trim().length > 0;
  const clearFilters = () => {
    setSearch('');
    setParams({ ...CLEARED_FILTER_PARAMS, search: '' });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const { truncated } = await exportUsersCsv(toAdminUsersFilter(params));
      if (truncated) toast.warning('The export hit its row cap. Narrow the filters to export the rest.');
    } catch (error) {
      console.error('Failed to export users CSV:', error);
      toast.error('Failed to download the user CSV.');
    } finally {
      setExporting(false);
    }
  };

  const summary = summaryQuery.data;
  const description = summary
    ? `${summary.total.toLocaleString()} accounts \u00b7 ${summary.activeThisWeek.toLocaleString()} active this week`
    : undefined;

  return (
    <Stack gap={2} sx={{ width: '100%', minWidth: 0, px: { xs: 2, sm: 3 }, py: 2.5 }} data-testid="admin-users-tab">
      <AdminPageHeader
        title="Users"
        description={description}
        actions={
          <>
            <Button
              variant={showRecentActivity ? 'soft' : 'plain'}
              size="sm"
              startDecorator={<HistoryIcon sx={{ fontSize: 16 }} />}
              onClick={() => setShowRecentActivity(shown => !shown)}
              aria-pressed={showRecentActivity}
              data-testid="admin-users-recent-activity-btn"
              sx={adminFocus}
            >
              Recent activity
            </Button>
            <Button
              variant="outlined"
              size="sm"
              startDecorator={<DownloadIcon sx={{ fontSize: 16 }} />}
              onClick={handleExport}
              loading={exporting}
              disabled={totalUsers === 0}
              data-testid="admin-users-export-btn"
              sx={adminFocus}
            >
              Export CSV
            </Button>
            <Button
              size="sm"
              startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
              onClick={() => setCreateUserModalOpen(true)}
              data-testid="admin-users-create-btn"
              sx={adminFocus}
            >
              New user
            </Button>
          </>
        }
      />

      <AnomalyBanner
        snapshot={anomalyQuery.data}
        onReview={() => {
          setSearch('');
          setParams({ ...CLEARED_FILTER_PARAMS, search: '', signedUp: 'hour', groupBy: 'emailDomain' });
        }}
      />
      {anomalyQuery.isError && <Alert color="warning">Could not check signup anomalies. Refresh to retry.</Alert>}
      <SignupActivityPanel
        range={signupRange}
        onRangeChange={setSignupRange}
        onSelectWindow={window => setParams({ ...window, signedUp: undefined, page: 1 })}
      />

      {showRecentActivity ? (
        <RecentActivityView />
      ) : (
        <>
          <UsersViewTabs
            params={params}
            search={search}
            summary={summary}
            onApply={patch => {
              setSearch(patch.search);
              setParams(patch);
            }}
          />
          <UsersToolbar params={params} search={search} onSearchChange={setSearch} onChange={setParams} />
          {params.groupBy && groupsQuery.data?.groupsTruncated && (
            <Alert color="warning" data-testid="admin-users-groups-truncated">
              Too many accounts match to group them all. Narrow the filters to see every domain.
            </Alert>
          )}

          <DataTable
            label="Users"
            testId="admin-users-table"
            rows={rows}
            columns={columns}
            getRowId={row => row.id}
            rowTestId={row => `admin-users-row-${row.id}`}
            loading={usersQuery.isLoading}
            error={usersQuery.isError ? 'Could not load users.' : undefined}
            onRetry={() => usersQuery.refetch()}
            empty={
              hasFilters ? (
                <EmptyState
                  title="No users match these filters"
                  description="Try removing a filter or searching by user ID."
                  action={
                    <Button variant="outlined" onClick={clearFilters} data-testid="admin-users-empty-clear-btn">
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="No users yet"
                  description="Accounts appear here as people sign up."
                  action={<Button onClick={() => setCreateUserModalOpen(true)}>New user</Button>}
                />
              )
            }
            selection={selection}
            onSelectionChange={setSelection}
            onRowActivate={row => openProfile(row.id)}
            sort={sort}
            onSortChange={onSortChange}
            groups={groups}
            rowActions={row => <UserRowActions row={row} onOpen={() => openProfile(row.id)} />}
            pagination={{
              page: params.page,
              pageSize: params.limit,
              total: totalUsers,
              onPageChange: page => setParams({ page }),
              onPageSizeChange: limit => setParams({ limit: limit as typeof params.limit, page: 1 }),
            }}
            minWidth="62rem"
            maxHeight="none"
          />

          <UsersBulkBar
            selection={selection}
            totalMatching={totalUsers}
            onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
            onClear={clearSelection}
            onAction={openBulkAction}
          />
        </>
      )}

      <AdminProfileModal />
      <ComplianceModal />
      <CreateUserModal />
      {/* Mounted only while open, so each run starts from a clean form and idempotency key. */}
      {bulkRun && (
        <UsersBulkActionDialog
          type={bulkRun.type}
          target={bulkRun.target}
          onClose={() => setBulkRun(null)}
          onDone={clearSelection}
        />
      )}
    </Stack>
  );
};

export default UsersTab;
