import { useState } from 'react';
import { Stack, Switch, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { ArenaModelWinRate } from '@bike4mind/common';
import {
  useAdminArenaPairs,
  useAdminArenaStats,
  useSetArenaPairActive,
  type AdminArenaPair,
} from '@client/app/hooks/data/preferenceArena';
import { getErrorMessage } from '@client/app/utils/error';
import PreferenceArenaImportBox from './PreferenceArenaImportBox';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionCard,
  StatStrip,
  StatTile,
  StatusChip,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

const REJECTION_LABELS: Record<string, string> = {
  rewards_off: 'Rewards off',
  too_fast: 'Too fast',
  gold_missed: 'Gold missed',
  unqualified: 'Not yet qualified',
  low_gold_accuracy: 'Low gold accuracy',
  daily_cap: 'Daily cap',
  lifetime_cap: 'Lifetime cap',
  reward_blocked: 'Reward blocked',
};

const PAGE_LIMIT = 25;

function winPercent(row: ArenaModelWinRate): number {
  const total = row.wins + row.losses + row.ties;
  return total === 0 ? 0 : (row.wins / total) * 100;
}

const WIN_RATE_COLUMNS: DataColumn<ArenaModelWinRate>[] = [
  { id: 'taskType', label: 'Task type', render: row => row.taskType, sortValue: row => row.taskType },
  { id: 'modelId', label: 'Model', render: row => row.modelId, sortValue: row => row.modelId },
  { id: 'wins', label: 'Wins', numeric: true, render: row => row.wins, sortValue: row => row.wins },
  { id: 'losses', label: 'Losses', numeric: true, render: row => row.losses, sortValue: row => row.losses },
  { id: 'ties', label: 'Ties', numeric: true, render: row => row.ties, sortValue: row => row.ties },
  {
    id: 'winPercent',
    label: 'Win %',
    numeric: true,
    render: row => `${winPercent(row).toFixed(1)}%`,
    sortValue: winPercent,
  },
];

function StatsSection() {
  const { data: stats, isPending, isError, error, refetch } = useAdminArenaStats();

  if (isError) return <ErrorState message={getErrorMessage(error)} onRetry={() => void refetch()} />;

  const rejections = Object.entries(stats?.rejections ?? {}).filter(([, count]) => (count ?? 0) > 0);

  return (
    <Stack gap={2}>
      <StatStrip aria-label="Preference arena totals">
        <StatTile
          label="Pairs"
          value={stats?.pairs.total ?? '-'}
          comparison={stats ? `${stats.pairs.active} active, ${stats.pairs.gold} gold` : undefined}
        />
        <StatTile
          label="Votes"
          value={stats?.votes.total ?? '-'}
          comparison={stats ? `${stats.votes.credited} credited` : undefined}
        />
        <StatTile
          label="Raters"
          value={stats?.raters.total ?? '-'}
          comparison={
            stats
              ? `${stats.raters.qualified} qualified, ${stats.raters.flagged} flagged, ${stats.pairs.activeGold} active gold`
              : undefined
          }
        />
        <StatTile label="Credits awarded" value={stats?.votes.creditsAwarded ?? '-'} />
      </StatStrip>
      <SectionCard title="Rejected votes" body="custom" data-testid="arena-rejections-card">
        {rejections.length > 0 ? (
          <Stack direction="row" gap={1} flexWrap="wrap" sx={{ p: 2 }}>
            {rejections.map(([reason, count]) => (
              <StatusChip key={reason} tone="neutral" label={`${REJECTION_LABELS[reason] ?? reason}: ${count}`} />
            ))}
          </Stack>
        ) : isPending ? (
          <LoadingState label="Loading rejected votes" testId="arena-rejections-loading" />
        ) : (
          <EmptyState
            title="No rejected votes"
            description="Votes the arena turns down for credit are counted here by reason."
            action={null}
          />
        )}
      </SectionCard>
      <SectionCard title="Win rate by task type and model" body="custom" data-testid="arena-winrates-card">
        <DataTable
          rows={stats?.winRates ?? []}
          columns={WIN_RATE_COLUMNS}
          getRowId={row => `${row.taskType}:${row.modelId}`}
          label="Win rates"
          loading={isPending}
          onRetry={() => void refetch()}
          empty={
            <EmptyState
              title="No votes yet"
              description="Win rates appear here once users compare two answers in the arena."
              action={null}
            />
          }
          testId="arena-winrates-table"
        />
      </SectionCard>
    </Stack>
  );
}

function PairsSection() {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(PAGE_LIMIT);
  const { data, isPending, isError, error, refetch } = useAdminArenaPairs(page, limit);
  const setActive = useSetArenaPairActive();

  const columns: DataColumn<AdminArenaPair>[] = [
    {
      id: 'prompt',
      label: 'Prompt',
      render: row => (
        <Typography level="body-sm" noWrap sx={{ maxWidth: '28rem', color: 'admin.ink' }}>
          {row.prompt}
        </Typography>
      ),
    },
    { id: 'taskType', label: 'Task type', render: row => row.taskType },
    { id: 'source', label: 'Source', render: row => row.source },
    { id: 'models', label: 'Models', render: row => row.modelIds.join(' vs ') },
    {
      id: 'isGold',
      label: 'Gold',
      render: row => (row.isGold ? <StatusChip tone="info" label="Gold" /> : <span aria-hidden>-</span>),
    },
    {
      id: 'active',
      label: 'Active',
      render: row => (
        <Switch
          size="sm"
          checked={row.active}
          disabled={setActive.isPending}
          onChange={event =>
            setActive.mutate(
              { id: row.id, active: event.target.checked },
              { onError: toggleError => toast.error(getErrorMessage(toggleError)) }
            )
          }
          slotProps={{
            input: {
              'aria-label': `Active: ${row.prompt.slice(0, 40)}`,
              'data-testid': `arena-pair-active-${row.id}`,
            },
          }}
        />
      ),
    },
  ];

  return (
    <SectionCard title="Pairs" body="custom" data-testid="arena-pairs-card">
      <DataTable
        rows={data?.rows ?? []}
        columns={columns}
        getRowId={row => row.id}
        label="Arena pairs"
        loading={isPending}
        error={isError ? getErrorMessage(error) : undefined}
        onRetry={() => void refetch()}
        empty={<EmptyState title="No pairs yet" description="Import pairs below to start the arena." action={null} />}
        testId="arena-pairs-table"
        pagination={{
          page,
          pageSize: limit,
          total: data?.total ?? 0,
          onPageChange: setPage,
          onPageSizeChange: size => {
            setLimit(size);
            setPage(1);
          },
        }}
      />
    </SectionCard>
  );
}

export default function PreferenceArenaTab() {
  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="preference-arena-tab">
      <AdminPageHeader
        title="Preference arena"
        description="Blind pairwise comparisons that verified users judge for promotional credits. Settings live under Pricing."
      />
      <StatsSection />
      <PairsSection />
      <PreferenceArenaImportBox />
    </Stack>
  );
}
