import { Button, Link, Stack } from '@mui/joy';
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
  PENDING_REASON_PARAM,
  PENDING_SORT_PARAM,
  PENDING_SORTS,
  PENDING_SOURCE_PARAM,
  PENDING_SOURCES,
  PENDING_STATUS_PARAM,
  PENDING_STATUSES,
} from '../../inviteCenterSearch';
import { useAdminModal } from '../../useAdminModal';
import { DataTable, type DataColumn } from '../../shared/DataTable';
import { EmptyState } from '../../shared/EmptyState';
import { RelativeTime } from '../../shared/EntityHeader';
import { FilterBar, type AdminFilter } from '../../shared/FilterBar';
import { StatStrip, StatTile } from '../../shared/StatStrip';
import { StatusChip } from '../../shared/StatusChip';
import { useAdminListUrlState, type AdminListSearchKeys } from '../../shared/useAdminListUrlState';

const CREDITS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const credits = (value: number) => CREDITS.format(value);
const UNAVAILABLE = 'Unavailable';

// The query and view keys are never written: this list has no search box and no saved views.
const LIST_KEYS: AdminListSearchKeys = {
  query: 'pendingQuery',
  view: 'pendingView',
  filters: {
    status: PENDING_STATUS_PARAM,
    heldReason: PENDING_REASON_PARAM,
    source: PENDING_SOURCE_PARAM,
    sort: PENDING_SORT_PARAM,
  },
};

const STATUS_LABEL: Readonly<Record<(typeof PENDING_STATUSES)[number], string>> = {
  held: 'Held',
  dripping: 'Dripping',
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
  </Stack>
);

export function PendingSection() {
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  const navigate = useNavigate();
  const [listState, updateList] = useAdminListUrlState(LIST_KEYS);
  const filters: PendingListFilters = {
    status: pick(PENDING_STATUSES, listState.filters.status),
    heldReason: pick(PENDING_HELD_REASONS, listState.filters.heldReason),
    source: pick(PENDING_SOURCES, listState.filters.source),
    sort: pick(PENDING_SORTS, listState.filters.sort) ?? 'oldest',
  };
  const list = useAdminSignupGrantPendingList(filters);
  const rows = list.data?.pages.flatMap(page => page.data) ?? [];
  const filtered = Object.values(listState.filters).some(Boolean);

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
      description="Pending lists accounts that still have signup credits to come: a held grant waiting on the daily pool or a risk review, a drip still paying out, or a grant blocked by an admin."
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
    </Stack>
  );
}
