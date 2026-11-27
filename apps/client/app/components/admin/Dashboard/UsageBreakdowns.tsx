import { Button, Chip, Stack, Typography } from '@mui/joy';
import type { CostByModelRow, SpendByAccountRow, SpendData, SpendFeatureRow } from '@bike4mind/common';
import { DataTable, InlineBar, SectionCard, type DataColumn } from '../shared';
import { formatCount } from '../Analytics/analyticsFormat';
import { formatShare, formatUsd } from '../SpendExplorer/spendExplorerModel';
import { seriesLabel } from '../SpendExplorer/seriesLabels';
import { AdminTab } from '../adminSidebarConfig';

/** The cards sit three across; their tables squeeze to this before scrolling sideways. */
const CARD_TABLE_MIN_WIDTH = '16rem';
const TOP_ROWS = 6;

type QueryState<T> = { data: T | undefined; isLoading: boolean; isError: boolean; refetch: () => unknown };

const FLAG_LABELS: Record<SpendByAccountRow['flags'][number], string> = {
  dailyCost: 'High daily cost',
  errorRate: 'High error rate',
  p95Latency: 'Slow',
};

function OpenButton({ label, tab, onNavigate }: { label: string; tab: AdminTab; onNavigate: (tab: AdminTab) => void }) {
  return (
    <Button size="sm" variant="plain" onClick={() => onNavigate(tab)} aria-label={`Open ${label}`}>
      Open
    </Button>
  );
}

export function TopFeaturesCard({
  features,
  onNavigate,
}: {
  features: QueryState<{ features: SpendFeatureRow[] }>;
  onNavigate: (tab: AdminTab) => void;
}) {
  const rows = [...(features.data?.features ?? [])]
    .sort((a, b) => b.distinctUsers - a.distinctUsers)
    .slice(0, TOP_ROWS);
  const maxUsers = rows[0]?.distinctUsers ?? 0;
  const columns: DataColumn<SpendFeatureRow>[] = [
    { id: 'feature', label: 'Feature', render: row => seriesLabel('feature', row.feature) },
    {
      id: 'users',
      label: 'Users',
      numeric: true,
      width: '7rem',
      render: row => (
        <Stack direction="row" gap={1} alignItems="center" justifyContent="flex-end">
          {formatCount(row.distinctUsers)}
          <InlineBar value={row.distinctUsers} max={maxUsers} />
        </Stack>
      ),
    },
    { id: 'cost', label: 'Cost', numeric: true, width: '5rem', render: row => formatUsd(row.costUsd) },
  ];
  return (
    <SectionCard
      title="Most used features"
      body="custom"
      data-testid="admin-dashboard-features"
      action={<OpenButton label="Spend explorer" tab={AdminTab.SpendExplorer} onNavigate={onNavigate} />}
    >
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={row => row.feature}
        label="Most used features"
        pagination={false}
        minWidth={CARD_TABLE_MIN_WIDTH}
        loading={features.isLoading}
        error={features.isError ? 'Feature usage could not be loaded.' : undefined}
        onRetry={() => void features.refetch()}
        testId="admin-dashboard-features-table"
      />
    </SectionCard>
  );
}

export function ModelsByCostCard({
  spend,
  onNavigate,
}: {
  spend: QueryState<SpendData>;
  onNavigate: (tab: AdminTab) => void;
}) {
  const rows = [...(spend.data?.byModel ?? [])].sort((a, b) => b.estCost - a.estCost).slice(0, TOP_ROWS);
  const columns: DataColumn<CostByModelRow>[] = [
    { id: 'model', label: 'Model', render: row => row.modelName },
    { id: 'cost', label: 'Cost', numeric: true, width: '5rem', render: row => formatUsd(row.estCost) },
    { id: 'share', label: 'Share', numeric: true, width: '4rem', render: row => formatShare(row.share) },
  ];
  return (
    <SectionCard
      title="Models by cost"
      body="custom"
      data-testid="admin-dashboard-models"
      action={<OpenButton label="Model metrics" tab={AdminTab.ModelMetrics} onNavigate={onNavigate} />}
    >
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={row => row.modelId}
        label="Models by cost"
        pagination={false}
        minWidth={CARD_TABLE_MIN_WIDTH}
        loading={spend.isLoading}
        error={spend.isError ? 'Model costs could not be loaded.' : undefined}
        onRetry={() => void spend.refetch()}
        testId="admin-dashboard-models-table"
      />
    </SectionCard>
  );
}

export function TopAccountsCard({
  spend,
  onNavigate,
}: {
  spend: QueryState<SpendData>;
  onNavigate: (tab: AdminTab) => void;
}) {
  const rows = [...(spend.data?.byAccount ?? [])].sort((a, b) => b.estCost - a.estCost).slice(0, TOP_ROWS);
  const columns: DataColumn<SpendByAccountRow>[] = [
    {
      id: 'account',
      label: 'Account',
      render: row => (
        <Stack direction="row" gap={0.5} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography noWrap sx={{ minWidth: 0 }}>
            {row.accountName}
          </Typography>
          {row.flags.map(flag => (
            <Chip key={flag} size="sm" variant="soft" color="warning">
              {FLAG_LABELS[flag]}
            </Chip>
          ))}
        </Stack>
      ),
    },
    { id: 'cost', label: 'Cost', numeric: true, width: '5rem', render: row => formatUsd(row.estCost) },
  ];
  return (
    <SectionCard
      title="Top accounts by cost"
      body="custom"
      data-testid="admin-dashboard-accounts"
      action={<OpenButton label="Spend monitor" tab={AdminTab.SpendMonitor} onNavigate={onNavigate} />}
    >
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={row => row.accountId}
        label="Top accounts by cost"
        pagination={false}
        minWidth={CARD_TABLE_MIN_WIDTH}
        loading={spend.isLoading}
        error={spend.isError ? 'Account costs could not be loaded.' : undefined}
        onRetry={() => void spend.refetch()}
        testId="admin-dashboard-accounts-table"
      />
    </SectionCard>
  );
}
