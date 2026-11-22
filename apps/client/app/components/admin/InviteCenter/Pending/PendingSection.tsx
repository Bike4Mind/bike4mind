import { useState } from 'react';
import { Alert, Button, Link, Stack } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { AdminSignupGrantPendingRow } from '@bike4mind/common';
import {
  useAdminSignupGrantPendingList,
  useAdminSignupGrantPendingSummary,
  type PendingListFilters,
} from '@client/app/hooks/data/adminSignupGrant';
import { AdminTab } from '../../adminSidebarConfig';
import {
  INVITE_CENTER_HELD_GRANTS_PARAM,
  INVITE_CENTER_SEARCH_PARSERS,
  PENDING_ACTIVE_DAYS,
  PENDING_HELD_REASONS,
  PENDING_INVITES,
  PENDING_SEARCH_KEYS,
  PENDING_SORTS,
  PENDING_SOURCES,
  PENDING_STATUSES,
} from '../../inviteCenterSearch';
import type { AdminSearch } from '../../adminTabParams';
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
import HeldGrantActions from './HeldGrantActions';

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
const INVITE_LABEL: Readonly<Record<(typeof PENDING_INVITES)[number], string>> = {
  invited: 'Invited',
  uninvited: 'Not invited',
};
const INVITE_SOURCE_LABEL: Readonly<Record<NonNullable<AdminSignupGrantPendingRow['inviteSource']>, string>> = {
  referral: 'Referral invite',
  organization: 'Organization invite',
};
const SORT_LABEL: Readonly<Record<(typeof PENDING_SORTS)[number], string>> = {
  oldest: 'Oldest first',
  remaining: 'Most remaining',
};

const options = <K extends string>(labels: Readonly<Record<K, string>>) =>
  (Object.entries(labels) as [K, string][]).map(([value, label]) => ({ value, label }));

const DEFAULT_ACTIVE_DAYS: (typeof PENDING_ACTIVE_DAYS)[number] = '7';
const lastDays = (days: string | number) => `last ${days} day${Number(days) === 1 ? '' : 's'}`;

const FILTERS: readonly AdminFilter[] = [
  { id: 'status', label: 'Status', options: options(STATUS_LABEL) },
  { id: 'heldReason', label: 'Held reason', options: options(REASON_LABEL) },
  { id: 'source', label: 'Source', options: options(SOURCE_LABEL) },
  { id: 'invite', label: 'Invite', options: options(INVITE_LABEL) },
  {
    id: 'activeDays',
    label: 'Activity',
    options: PENDING_ACTIVE_DAYS.map(value => ({ value, label: `Active in ${lastDays(value)}` })),
  },
  { id: 'sort', label: 'Sort', options: options(SORT_LABEL) },
];

const pick = <T extends string>(allowed: readonly T[], value: string): T | undefined =>
  (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

const parseHeldGrants = INVITE_CENTER_SEARCH_PARSERS[INVITE_CENTER_HELD_GRANTS_PARAM];

const NO_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };

const SECTION_LINKS = [
  { label: 'Open Signup domain holds', tab: AdminTab.SignupDomainHolds, testId: 'pending-open-domain-holds-btn' },
  { label: 'Open Risk review queue', tab: AdminTab.SignupRiskReview, testId: 'pending-open-risk-review-btn' },
] as const;

const PendingHeader = ({ activeDays }: { activeDays: number }) => {
  const { data, isError } = useAdminSignupGrantPendingSummary(activeDays);
  const exposure = data?.exposure;
  const trickle = data?.trickle;
  const queue = data?.queue;
  const activity = data?.activity;
  const drip = data?.drip;
  const poolLeft = trickle && !trickle.missing ? Math.max(0, trickle.limit - trickle.spentToday) : null;
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
        label={`Payable, active in ${lastDays(activeDays)}`}
        value={activity ? activity.accounts : activity === null ? UNAVAILABLE : blank}
        comparison={activity ? `${credits(activity.remaining)} left in their grants` : undefined}
      />
      <StatTile
        label="Drip due today (UTC)"
        value={drip ? credits(drip.committed) : drip === null ? UNAVAILABLE : blank}
        comparison={
          drip
            ? `Upper bound if all ${drip.accounts} are active${poolLeft !== null ? `; ${credits(poolLeft)} left in the pool` : ''}${poolLeft !== null && drip.committed > poolLeft ? ` (${credits(drip.committed - poolLeft)} over)` : ''}`
            : undefined
        }
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
  const search = useSearch({ strict: false }) as AdminSearch;
  const heldActionsOpen = parseHeldGrants(search[INVITE_CENTER_HELD_GRANTS_PARAM]) === 'open';
  const [heldActionsOpened, setHeldActionsOpened] = useState(false);
  const heldActionsMounted = heldActionsOpened || heldActionsOpen;
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  const navigate = useNavigate();
  const toggleHeldActions = () => {
    setHeldActionsOpened(true);
    return navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({
        ...previous,
        [INVITE_CENTER_HELD_GRANTS_PARAM]: heldActionsOpen ? undefined : ('open' as const),
      }),
      replace: true,
    });
  };
  const [listState, setListState] = useAdminListUrlState(PENDING_SEARCH_KEYS);
  const filters: PendingListFilters = {
    status: pick(PENDING_STATUSES, listState.filters.status),
    heldReason: pick(PENDING_HELD_REASONS, listState.filters.heldReason),
    source: pick(PENDING_SOURCES, listState.filters.source),
    invite: pick(PENDING_INVITES, listState.filters.invite),
    activeDays: pick(PENDING_ACTIVE_DAYS, listState.filters.activeDays),
    sort: pick(PENDING_SORTS, listState.filters.sort) ?? 'oldest',
  };
  const list = useAdminSignupGrantPendingList(filters);
  const rows = list.data?.pages.flatMap(page => page.data) ?? [];
  const filtered = Boolean(
    filters.status || filters.heldReason || filters.source || filters.invite || filters.activeDays
  );
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
      // Fits the longest chip label on one line; two chips wrap instead of truncating.
      width: '11rem',
      render: row => (
        <Stack direction="row" flexWrap="wrap" gap={0.75}>
          {row.source ? (
            <StatusChip tone={row.source === 'package' ? 'info' : 'neutral'} label={SOURCE_LABEL[row.source]} />
          ) : null}
          {row.inviteSource ? (
            <StatusChip
              tone="info"
              label={INVITE_SOURCE_LABEL[row.inviteSource]}
              data-testid={`pending-row-invite-${row.id}`}
            />
          ) : null}
        </Stack>
      ),
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
          onClick={() =>
            updateList({ filters: { status: '', heldReason: '', source: '', invite: '', activeDays: '', sort: '' } })
          }
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
        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          data-testid="invite-center-open-held-grants-btn"
          aria-expanded={heldActionsOpen}
          onClick={() => void toggleHeldActions()}
        >
          {heldActionsOpen ? 'Hide held grant actions' : 'Held grant actions'}
        </Button>
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
      {heldActionsMounted && (
        <div hidden={!heldActionsOpen}>
          <HeldGrantActions />
        </div>
      )}
      <Stack gap={1.5} sx={{ display: heldActionsOpen ? 'none' : undefined }}>
        <PendingHeader activeDays={Number(filters.activeDays ?? DEFAULT_ACTIVE_DAYS)} />
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
    </Stack>
  );
}
