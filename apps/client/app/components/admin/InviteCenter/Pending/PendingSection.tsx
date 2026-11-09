import { useState } from 'react';
import { Alert, Button, Link, Stack } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import type { AdminSignupGrantPendingRow } from '@bike4mind/common';
import {
  useAdminSignupGrantPendingList,
  useAdminSignupGrantPendingSummary,
  type PendingListFilters,
} from '@client/app/hooks/data/adminSignupGrant';
import { AdminTab } from '../../adminSidebarConfig';
import {
  PENDING_HELD_REASONS,
  PENDING_SEARCH_KEYS,
  PENDING_SORTS,
  PENDING_SOURCES,
  PENDING_STATUSES,
} from '../../inviteCenterSearch';
import { useAdminModal } from '../../useAdminModal';
import { BulkActionBar, type AdminSelection } from '../../shared/BulkActionBar';
import { DataTable, type DataColumn } from '../../shared/DataTable';
import { EmptyState } from '../../shared/EmptyState';
import { RelativeTime } from '../../shared/EntityHeader';
import { FilterBar, type AdminFilter } from '../../shared/FilterBar';
import { StatStrip, StatTile } from '../../shared/StatStrip';
import { StatusChip } from '../../shared/StatusChip';
import { useAdminListUrlState } from '../../shared/useAdminListUrlState';
import { PendingBulkDialog } from './PendingBulkDialog';
import { MAX_PENDING_BULK, type PendingBulkKind } from './usePendingBulkActions';

const CREDITS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const credits = (value: number) => CREDITS.format(value);
const UNAVAILABLE = 'Unavailable';

const STATUS_LABEL: Readonly<Record<(typeof PENDING_STATUSES)[number], string>> = {
  held: 'Held',
  dripping: 'Dripping',
  locked: 'Locked',
  blocked: 'Blocked',
};
const REASON_LABEL: Readonly<Record<(typeof PENDING_HELD_REASONS)[number], string>> = {
  budget_exhausted: 'Daily pool spent',
  risk_review: 'Risk review',
};
const SOURCE_LABEL: Readonly<Record<(typeof PENDING_SOURCES)[number], string>> = {
  default: 'Default schedule',
  package: 'Grant package',
};
const SORT_LABEL: Readonly<Record<(typeof PENDING_SORTS)[number], string>> = {
  oldest: 'Oldest first',
  remaining: 'Most remaining',
};

const options = <K extends string>(labels: Readonly<Record<K, string>>) =>
  (Object.entries(labels) as [K, string][]).map(([value, label]) => ({ value, label }));

const FILTERS: readonly AdminFilter[] = [
  { id: 'status', label: 'Status', options: options(STATUS_LABEL) },
  { id: 'heldReason', label: 'Held reason', options: options(REASON_LABEL) },
  { id: 'source', label: 'Source', options: options(SOURCE_LABEL) },
  { id: 'sort', label: 'Sort', options: options(SORT_LABEL) },
];

const pick = <T extends string>(allowed: readonly T[], value: string): T | undefined =>
  (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

const NO_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };

const SECTION_LINKS = [
  { label: 'Open Held signup grants', tab: AdminTab.HeldSignupGrants, testId: 'invite-center-open-held-grants-btn' },
  { label: 'Open Signup domain holds', tab: AdminTab.SignupDomainHolds, testId: 'pending-open-domain-holds-btn' },
  { label: 'Open Risk review queue', tab: AdminTab.SignupRiskReview, testId: 'pending-open-risk-review-btn' },
] as const;

const PendingHeader = () => {
  const { data, isError } = useAdminSignupGrantPendingSummary();
  const exposure = data?.exposure;
  const trickle = data?.trickle;
  const queue = data?.queue;
  const blank = isError ? UNAVAILABLE : '-';
  return (
    <StatStrip aria-label="Pending signup credit exposure">
      <StatTile
        label="Accounts with remaining"
        value={exposure ? exposure.accountsWithRemaining : exposure === null ? UNAVAILABLE : blank}
      />
      <StatTile
        label="Remaining to drip"
        value={exposure ? credits(exposure.totalDripRemaining) : exposure === null ? UNAVAILABLE : blank}
        comparison={exposure ? `${credits(exposure.totalRemaining)} left in all grants` : undefined}
      />
      <StatTile
        label="Trickle pool today"
        value={
          trickle
            ? `${credits(trickle.spentToday)} of ${credits(trickle.limit)}`
            : trickle === null
              ? UNAVAILABLE
              : blank
        }
        comparison={trickle?.missing ? 'No trickle pool is set' : undefined}
      />
      <StatTile
        label="Held queue"
        value={queue ? queue.held : queue === null ? UNAVAILABLE : blank}
        comparison={
          queue?.oldestHeldAt ? <RelativeTime prefix="oldest" at={new Date(queue.oldestHeldAt)} /> : undefined
        }
      />
    </StatStrip>
  );
};

const StateChips = ({ row }: { row: AdminSignupGrantPendingRow }) => (
  <Stack direction="row" flexWrap="wrap" gap={0.75} data-testid={`pending-row-state-${row.id}`}>
    {row.status === 'blocked' && <StatusChip tone="bad" dot label="Blocked" />}
    {row.status === 'held' && (
      <StatusChip tone="warn" dot label={row.held?.reason ? `Held: ${REASON_LABEL[row.held.reason]}` : 'Held'} />
    )}
    {row.status === 'dripping' && <StatusChip tone="info" dot label="Dripping" />}
    {row.status === 'locked' && (
      <StatusChip tone="neutral" dot label={row.stage === 'pending_email' ? 'Awaiting email' : 'Locked'} />
    )}
  </Stack>
);

export function PendingSection() {
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  const navigate = useNavigate();
  const [listState, setListState] = useAdminListUrlState(PENDING_SEARCH_KEYS);
  const filters: PendingListFilters = {
    status: pick(PENDING_STATUSES, listState.filters.status),
    heldReason: pick(PENDING_HELD_REASONS, listState.filters.heldReason),
    source: pick(PENDING_SOURCES, listState.filters.source),
    sort: pick(PENDING_SORTS, listState.filters.sort) ?? 'oldest',
  };
  const list = useAdminSignupGrantPendingList(filters);
  const rows = list.data?.pages.flatMap(page => page.data) ?? [];
  const filtered = Boolean(filters.status || filters.heldReason || filters.source);
  const canRelease = list.data?.pages[0]?.viewer.canRelease === true;
  const [selection, setSelection] = useState<AdminSelection>(NO_SELECTION);
  const [dialog, setDialog] = useState<PendingBulkKind | null>(null);
  const filterKey = JSON.stringify(filters);
  const [selectionKey, setSelectionKey] = useState(filterKey);
  // Reset on URL navigation too, before stale selections can reach a bulk action.
  if (selectionKey !== filterKey) {
    setSelectionKey(filterKey);
    setSelection(NO_SELECTION);
    setDialog(null);
  }
  const updateList: typeof setListState = (...args) => {
    setSelection(NO_SELECTION);
    return setListState(...args);
  };
  const [failed, setFailed] = useState<readonly string[]>([]);
  // 'allMatching' is never offered: both bulk routes take explicit ids only.
  const selectedIds = selection.mode === 'explicit' ? selection.ids : [];
  const overCap = selectedIds.length > MAX_PENDING_BULK;
  const emailOf = new Map(rows.map(row => [row.id, row.email ?? row.id]));

  const openCredits = (userId: string) =>
    navigate({ to: '/admin/users/$userId', params: { userId }, search: { tab: 'credits' } });

  const columns: DataColumn<AdminSignupGrantPendingRow>[] = [
    {
      id: 'account',
      label: 'Account',
      sortable: false,
      render: row => (
        <Link
          component="button"
          level="body-sm"
          onClick={() => void openCredits(row.id)}
          data-testid={`pending-row-link-${row.id}`}
        >
          {row.email ?? row.id}
        </Link>
      ),
    },
    {
      id: 'source',
      label: 'Source',
      sortable: false,
      render: row =>
        row.source ? (
          <StatusChip tone={row.source === 'package' ? 'info' : 'neutral'} label={SOURCE_LABEL[row.source]} />
        ) : null,
    },
    { id: 'state', label: 'State', sortable: false, render: row => <StateChips row={row} /> },
    {
      id: 'remaining',
      label: 'Remaining',
      sortable: false,
      numeric: true,
      render: row => <span data-testid={`pending-row-remaining-${row.id}`}>{credits(row.remaining)}</span>,
    },
    {
      id: 'dripRemaining',
      label: 'Drip remaining',
      sortable: false,
      numeric: true,
      render: row => credits(row.dripRemaining),
    },
    {
      id: 'heldSince',
      label: 'Held since',
      sortable: false,
      render: row => (row.held?.since ? <RelativeTime at={new Date(row.held.since)} /> : null),
    },
    {
      id: 'rewards',
      label: 'Rewards',
      sortable: false,
      render: ({ rewards }) =>
        rewards.queuedCount + rewards.pausedCount === 0
          ? 'None'
          : [
              rewards.queuedCount > 0 && `${rewards.queuedCount} queued (${credits(rewards.queuedCredits)})`,
              rewards.pausedCount > 0 && `${rewards.pausedCount} paused (${credits(rewards.pausedCredits)})`,
            ]
              .filter(Boolean)
              .join(', '),
    },
  ];

  const empty = filtered ? (
    <EmptyState
      title="No accounts match these filters"
      action={
        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          data-testid="pending-clear-filters-btn"
          onClick={() => updateList({ filters: { status: '', heldReason: '', source: '', sort: '' } })}
        >
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      title="No pending signup grants"
      description="Pending lists accounts that still have signup credits to come: a held grant waiting on the daily pool or a risk review, a drip still paying out, a grant locked until the email is verified or an admin releases it, or a grant blocked by an admin."
      action={null}
    />
  );

  return (
    <Stack gap={1.5} data-testid="pending-section">
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        {SECTION_LINKS.map(({ label, tab, testId }) => (
          <Button
            key={tab}
            variant="outlined"
            color="neutral"
            size="sm"
            data-testid={testId}
            onClick={() => setActiveTab(tab)}
          >
            {label}
          </Button>
        ))}
      </Stack>
      <PendingHeader />
      <FilterBar state={listState} filters={FILTERS} onChange={updateList} search={false} />
      {failed.length > 0 && (
        <Alert color="warning" variant="soft" data-testid="pending-bulk-failed">
          Could not change: {failed.map(id => emailOf.get(id) ?? id).join(', ')}
        </Alert>
      )}
      {selectedIds.length > 0 && (
        <BulkActionBar
          selection={selection}
          totalMatching={selectedIds.length}
          onSelectAllMatching={() => undefined}
          onClear={() => setSelection(NO_SELECTION)}
        >
          {overCap && <span data-testid="pending-bulk-over-cap">Select {MAX_PENDING_BULK} accounts or fewer.</span>}
          {canRelease && (
            <Button
              size="sm"
              disabled={overCap}
              data-testid="pending-bulk-release-btn"
              onClick={() => setDialog('release')}
            >
              Release
            </Button>
          )}
          <Button
            size="sm"
            color="danger"
            variant="outlined"
            disabled={overCap}
            data-testid="pending-bulk-block-btn"
            onClick={() => setDialog('block')}
          >
            Block
          </Button>
        </BulkActionBar>
      )}
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={row => row.id}
        label="Pending signup grants"
        loading={list.isPending}
        error={list.isError ? 'Could not load pending signup grants.' : undefined}
        onRetry={() => void list.refetch()}
        empty={empty}
        pagination={false}
        selection={selection}
        onSelectionChange={setSelection}
        testId="pending-table"
        rowTestId={row => `pending-row-${row.id}`}
      />
      {list.hasNextPage && (
        <Stack direction="row" justifyContent="center">
          <Button
            variant="outlined"
            color="neutral"
            size="sm"
            loading={list.isFetchingNextPage}
            data-testid="pending-load-more-btn"
            onClick={() => void list.fetchNextPage()}
          >
            Load more
          </Button>
        </Stack>
      )}
      {dialog && (
        <PendingBulkDialog
          kind={dialog}
          userIds={selectedIds}
          onClose={() => setDialog(null)}
          onDone={outcome => {
            setFailed(outcome.failedIds);
            setSelection(NO_SELECTION);
          }}
        />
      )}
    </Stack>
  );
}
