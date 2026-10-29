import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Dropdown, IconButton, Menu, MenuButton, MenuItem, Skeleton, Stack } from '@mui/joy';
import DownloadIcon from '@mui/icons-material/Download';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { toast } from 'sonner';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import type { AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionsFilter';
import { downloadData } from '@client/app/utils/download';
import { AdminTab } from '../adminSidebarConfig';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  StatStrip,
  StatTile,
  ViewTabs,
  formatMoney,
  type DataTableSort,
  type ViewTab,
} from '../shared';
import { adminFocus } from '../shared/adminStyles';
import { useAdminModal } from '../useAdminModal';
import { SUBSCRIPTIONS_SORT_COLUMNS, subscriptionsColumns } from './subscriptionsColumns';
import { useSubscriptionsSeenOnOpen } from './subscriptionsLastSeen';
import { MrrDefinitionHelp, atRiskNote, mrrExclusionNote } from './subscriptionsMrr';
import {
  SUBSCRIPTIONS_BUILT_IN_VIEWS,
  activeSubscriptionsView,
  applySubscriptionsView,
} from './subscriptionsListViews';
import { SubscriptionsToolbar } from './SubscriptionsToolbar';
import { CLEARED_FILTER_PARAMS } from './subscriptionsTabSearch';
import {
  fetchSubscriptionsExport,
  toAdminSubscriptionsFilter,
  useAdminSubscriptionsList,
  useAdminSubscriptionsSummary,
  useSubscriptionsViewCounts,
} from './useAdminSubscriptionsList';
import { useOpenSubscriptionRow } from './useOpenSubscriptionRow';
import { useSubscriptionsParams, useSubscriptionsTab, useSubscriptionsTabUrlSync } from './useSubscriptionsTabParams';

const copyToClipboard = async (value: string, what: string) => {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}.`);
  }
};

function SubscriptionRowActions({ row, onOpen }: { row: AdminSubscriptionRow; onOpen: () => void }) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            'aria-label': `Actions for subscription ${row.subscriptionId}`,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        data-testid={`admin-subscriptions-row-actions-${row.id}`}
        // The row opens the customer on click; the menu must not.
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }} onClick={event => event.stopPropagation()}>
        {row.owner && (
          <MenuItem onClick={onOpen} data-testid={`admin-subscriptions-row-open-${row.id}`}>
            Open customer
          </MenuItem>
        )}
        {row.source === 'stripe' && (
          <MenuItem
            onClick={() => copyToClipboard(row.subscriptionId, 'Stripe subscription ID')}
            data-testid={`admin-subscriptions-row-copy-sub-${row.id}`}
          >
            Copy Stripe subscription ID
          </MenuItem>
        )}
        <MenuItem
          onClick={() => copyToClipboard(row.ownerId, 'Owner ID')}
          data-testid={`admin-subscriptions-row-copy-owner-${row.id}`}
        >
          Copy owner ID
        </MenuItem>
      </Menu>
    </Dropdown>
  );
}

// A failed query has no value to wait for, so it reads as unavailable rather than loading forever.
const tileValue = (value: number | string | undefined, isError = false) => {
  if (isError) return '\u2014';
  if (value !== undefined) return value;
  return <Skeleton variant="text" level="h3" width="3ch" data-testid="admin-stat-skeleton" />;
};

const AdminSubscriptions: React.FC = () => {
  useSubscriptionsTabUrlSync();
  const [params, setParams] = useSubscriptionsParams();
  const openRow = useOpenSubscriptionRow();
  const setAdminTab = useAdminModal(state => state.setActiveTab);
  const [exporting, setExporting] = useState(false);

  // Seeded from the persisted params so a restored search is not wiped on mount.
  const {
    value: search,
    debouncedValue: debouncedSearch,
    setValue: setSearch,
  } = useDebounceValue(useSubscriptionsTab.getState().params.search ?? '');
  useEffect(() => {
    // A view or clear sets the input and params together; the stale debounced value must not undo it.
    if (search !== debouncedSearch) return;
    if (debouncedSearch === params.search) return;
    setParams({ search: debouncedSearch, page: 1 });
  }, [search, debouncedSearch, params.search, setParams]);

  const filter = toAdminSubscriptionsFilter(params);
  const listQuery = useAdminSubscriptionsList(params);
  const newSince = useSubscriptionsSeenOnOpen(
    listQuery.isSuccess && listQuery.isFetchedAfterMount && !listQuery.isPlaceholderData
  );
  const summaryQuery = useAdminSubscriptionsSummary(filter);
  // Another cancel filter would be overwritten, so the tile only counts when none (or this one) is set.
  const cancelingCountable = filter.cancel === undefined || filter.cancel === 'scheduled';
  const cancelingQuery = useAdminSubscriptionsSummary(
    { ...filter, cancel: 'scheduled' },
    { enabled: cancelingCountable }
  );
  const viewCountsQuery = useSubscriptionsViewCounts();
  const viewCounts = viewCountsQuery.data;
  const summariesFailed =
    summaryQuery.isError || (cancelingCountable && cancelingQuery.isError) || viewCountsQuery.isError;
  const retrySummaries = () => {
    void summaryQuery.refetch();
    if (cancelingCountable) void cancelingQuery.refetch();
    viewCountsQuery.refetch();
  };

  const rows = useMemo(() => listQuery.data?.subscriptions ?? [], [listQuery.data]);
  const total = listQuery.data?.total;
  const columns = useMemo(() => subscriptionsColumns({ now: new Date(), newSince }), [newSince]);

  const activeView = activeSubscriptionsView(params);
  const viewTabs: ViewTab[] = SUBSCRIPTIONS_BUILT_IN_VIEWS.map(view => ({
    id: view.id,
    label: view.label,
    count: viewCounts?.[view.id],
  }));
  const applyView = (id: string) => {
    const view = SUBSCRIPTIONS_BUILT_IN_VIEWS.find(candidate => candidate.id === id);
    if (!view) return;
    setSearch('');
    setParams({ ...applySubscriptionsView(view), search: '' });
  };

  const sortColumn = Object.entries(SUBSCRIPTIONS_SORT_COLUMNS).find(([, field]) => field === params.sortField)?.[0];
  const sort: DataTableSort | undefined = sortColumn
    ? { columnId: sortColumn, direction: params.sortOrder }
    : undefined;
  const onSortChange = (next: DataTableSort) => {
    const sortField = SUBSCRIPTIONS_SORT_COLUMNS[next.columnId];
    if (sortField) setParams({ sortField, sortOrder: next.direction, page: 1 });
  };

  const searching = params.search.trim().length > 0;
  const clearFilters = () => {
    setSearch('');
    setParams({ ...CLEARED_FILTER_PARAMS, search: '' });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await fetchSubscriptionsExport(filter);
      downloadData(result.blob, result.fileName, 'text/csv;charset=utf-8;');
      if (result.truncated) toast.warning('The export hit its row cap. Narrow the filters to export the rest.');
      if (result.searchTruncated)
        toast.warning('The search matched too many accounts. Narrow it to export every match.');
    } catch (error) {
      console.error('Failed to export subscriptions CSV:', error);
      toast.error('Failed to download the subscriptions CSV.');
    } finally {
      setExporting(false);
    }
  };

  const viewAll = (
    <Button variant="outlined" onClick={() => applyView('all')} data-testid="admin-subscriptions-empty-view-all-btn">
      View all subscriptions
    </Button>
  );
  const empty =
    activeView && !searching ? (
      activeView.id === 'all' ? (
        <EmptyState
          title={activeView.empty.title}
          description={activeView.empty.description}
          action={
            <Button
              variant="outlined"
              onClick={() => setAdminTab(AdminTab.GrowthPricing)}
              data-testid="admin-subscriptions-empty-pricing-btn"
            >
              View pricing settings
            </Button>
          }
        />
      ) : (
        <EmptyState title={activeView.empty.title} description={activeView.empty.description} action={viewAll} />
      )
    ) : (
      <EmptyState
        title="No subscriptions match these filters"
        description="Try removing a filter, or search by an exact Stripe ID."
        action={
          <Button variant="outlined" onClick={clearFilters} data-testid="admin-subscriptions-empty-clear-btn">
            {searching ? 'Clear search and filters' : 'Clear filters'}
          </Button>
        }
      />
    );

  const summary = summaryQuery.data;
  const pastDue = summary?.views.pastDue;
  const mrr = summary?.mrr;

  return (
    <Stack
      gap={2}
      sx={{ width: '100%', minWidth: 0, px: { xs: 2, sm: 3 }, py: 2.5 }}
      data-testid="admin-subscriptions-tab"
    >
      <AdminPageHeader
        title="Subscriptions"
        count={total}
        description="Stripe plans and admin comps, for users and organizations."
        actions={
          <Button
            size="sm"
            startDecorator={<DownloadIcon sx={{ fontSize: 16 }} />}
            onClick={handleExport}
            loading={exporting}
            disabled={!total}
            data-testid="admin-subscriptions-export-btn"
            sx={adminFocus}
          >
            Export CSV
          </Button>
        }
      />

      {summariesFailed && (
        <Alert
          color="warning"
          data-testid="admin-subscriptions-summary-error"
          endDecorator={
            <Button
              size="sm"
              variant="plain"
              onClick={retrySummaries}
              data-testid="admin-subscriptions-summary-retry-btn"
            >
              Retry totals
            </Button>
          }
        >
          Could not load subscription totals. Retry to refresh the totals and view counts.
        </Alert>
      )}
      <StatStrip aria-label="Subscription totals for the current filters">
        <StatTile label="Paying" value={tileValue(summary?.views.paying, summaryQuery.isError)} />
        <StatTile
          label="MRR"
          help={<MrrDefinitionHelp />}
          value={tileValue(mrr && formatMoney(mrr.amount, mrr.currency, { compact: true }), summaryQuery.isError)}
          comparison={!summaryQuery.isError && mrr && mrrExclusionNote(mrr)}
        />
        <StatTile
          label="Past due"
          value={tileValue(pastDue, summaryQuery.isError)}
          valueColor={pastDue ? 'admin.status.warn.foreground' : undefined}
          comparison={
            !summaryQuery.isError && pastDue && summary?.pastDueMrr ? atRiskNote(summary.pastDueMrr) : undefined
          }
        />
        <StatTile
          label="Canceling"
          value={cancelingCountable ? tileValue(cancelingQuery.data?.total, cancelingQuery.isError) : '\u2014'}
          comparison={cancelingCountable ? 'Cancel requested, still running' : undefined}
        />
      </StatStrip>

      <ViewTabs
        aria-label="Subscription views"
        data-testid="admin-subscriptions-views"
        activeId={activeView?.id ?? ''}
        views={viewTabs}
        onSelect={applyView}
      />
      <SubscriptionsToolbar params={params} search={search} onSearchChange={setSearch} onChange={setParams} />
      {listQuery.data?.searchTruncated && (
        <Alert color="warning" data-testid="admin-subscriptions-search-truncated">
          This search matches more accounts than the list can resolve. Narrow it to see every match.
        </Alert>
      )}

      <DataTable
        label="Subscriptions"
        testId="admin-subscriptions-table"
        rows={rows}
        columns={columns}
        getRowId={row => row.id}
        rowTestId={row => `admin-subscriptions-row-${row.id}`}
        loading={listQuery.isLoading}
        error={listQuery.isError ? 'Could not load subscriptions.' : undefined}
        onRetry={() => listQuery.refetch()}
        empty={empty}
        onRowActivate={openRow}
        sort={sort}
        onSortChange={onSortChange}
        rowActions={row => <SubscriptionRowActions row={row} onOpen={() => openRow(row)} />}
        pagination={{
          page: params.page,
          pageSize: params.limit,
          total: total ?? 0,
          onPageChange: page => setParams({ page }),
          onPageSizeChange: limit => setParams({ limit, page: 1 }),
        }}
        minWidth="62rem"
        maxHeight="none"
      />
    </Stack>
  );
};

export default AdminSubscriptions;
