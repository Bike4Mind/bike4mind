import { useMemo } from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/joy';
import type { SpendAccountRow, SpendAccountsResponse, SpendBucketSize, SpendTimelineBucket } from '@bike4mind/common';
import { DataTable, SectionCard, type DataColumn } from '../shared';
import { formatBucket, formatShare, formatUsd, multipleOfBaseline } from './spendExplorerModel';
import { providerLabel, SEGMENT_LABELS } from './seriesLabels';

const DAY_MS = 24 * 60 * 60 * 1000;

/** "5d", "3mo", "2y": how long the account has existed at `now`. */
export function formatAccountAge(createdAt: string | null, now: Date = new Date()): string | null {
  if (!createdAt) return null;
  const days = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / DAY_MS));
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** "Personal", an org name, or "Org A +1" when the user's calls were billed to several payers. */
export function formatPayers(row: Pick<SpendAccountRow, 'accountId' | 'payers'>): string {
  const [first, ...rest] = row.payers;
  if (!first) return '-';
  const label = first.ownerId === row.accountId ? 'Personal' : first.name;
  return rest.length > 0 ? `${label} +${rest.length}` : label;
}

type SpendDrillDownProps = {
  /** The selected bucket, or null when the panel covers the whole range. */
  bucket: SpendTimelineBucket | null;
  bucketSize: SpendBucketSize;
  rangeLabel: string;
  accounts: SpendAccountsResponse | undefined;
  isLoading: boolean;
  error: string | undefined;
  onRetry: () => void;
  onSelectAccount: (account: SpendAccountRow) => void;
  onClear: () => void;
};

function ShareLine({
  label,
  costUsd,
  total,
  testId,
}: {
  label: string;
  costUsd: number;
  total: number;
  testId: string;
}) {
  return (
    <Stack direction="row" justifyContent="space-between" gap={2} data-testid={testId}>
      <Typography level="body-sm">{label}</Typography>
      <Typography level="body-sm" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatUsd(costUsd)}{' '}
        <Typography component="span" textColor="admin.inkMuted">
          {total > 0 ? formatShare(costUsd / total) : '-'}
        </Typography>
      </Typography>
    </Stack>
  );
}

/**
 * The drill-down beside the chart: one bucket (or the whole range) with its total
 * against the rolling median, its provider and account-type cuts, and the top
 * spenders. Selecting a spender opens that account's own spend.
 */
export function SpendDrillDown({
  bucket,
  bucketSize,
  rangeLabel,
  accounts,
  isLoading,
  error,
  onRetry,
  onSelectAccount,
  onClear,
}: SpendDrillDownProps) {
  const multiple = bucket ? multipleOfBaseline(bucket) : null;
  const total = accounts?.totalCostUsd ?? 0;

  const columns: DataColumn<SpendAccountRow>[] = useMemo(
    () => [
      {
        id: 'name',
        label: 'Account',
        render: row => (
          <Stack direction="row" gap={0.75} alignItems="center" sx={{ minWidth: 0 }}>
            <Typography level="body-sm" noWrap>
              {row.name}
            </Typography>
            {row.segment !== 'customer' && (
              <Chip size="sm" variant="soft" data-testid={`spend-drilldown-segment-chip-${row.accountId}`}>
                {SEGMENT_LABELS[row.segment]}
              </Chip>
            )}
            {row.newInTop10 && (
              <Chip size="sm" variant="soft" color="warning" data-testid={`spend-drilldown-new-chip-${row.accountId}`}>
                New
              </Chip>
            )}
          </Stack>
        ),
        sortValue: row => row.name,
      },
      {
        id: 'payer',
        label: 'Billed to',
        width: '9rem',
        render: row => (
          <Typography level="body-sm" noWrap data-testid={`spend-drilldown-payer-${row.accountId}`}>
            {formatPayers(row)}
          </Typography>
        ),
      },
      {
        id: 'cost',
        label: 'Cost (USD)',
        numeric: true,
        width: '7rem',
        render: row => formatUsd(row.costUsd),
        sortValue: row => row.costUsd,
      },
      {
        id: 'share',
        label: 'Share',
        numeric: true,
        width: '5rem',
        render: row => formatShare(row.share),
        sortValue: row => row.share,
      },
      {
        id: 'age',
        label: 'Age',
        numeric: true,
        width: '5rem',
        render: row => formatAccountAge(row.createdAt) ?? '-',
        sortValue: row => (row.createdAt ? -new Date(row.createdAt).getTime() : 0),
      },
    ],
    []
  );

  const title = bucket ? `${formatBucket(bucket.start, bucketSize)} UTC` : `${rangeLabel} UTC`;

  return (
    <SectionCard
      title={title}
      body="custom"
      data-testid="spend-drilldown-panel"
      action={
        bucket ? (
          <Button size="sm" variant="plain" onClick={onClear} data-testid="spend-drilldown-clear-btn">
            Show whole range
          </Button>
        ) : undefined
      }
    >
      <Stack gap={2} sx={{ p: 2 }}>
        <Stack direction="row" gap={1.5} alignItems="baseline" flexWrap="wrap">
          <Typography level="h3" data-testid="spend-drilldown-total" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatUsd(bucket ? bucket.totalUsd : total)}
          </Typography>
          {bucket && (
            <>
              <Typography level="body-sm" textColor="admin.inkMuted" data-testid="spend-drilldown-multiple">
                {multiple === null
                  ? 'No median yet'
                  : `${multiple.toFixed(1)}x the rolling median (${formatUsd(bucket.baselineUsd)})`}
              </Typography>
              <Chip
                size="sm"
                variant="soft"
                color={bucket.isSpike ? 'danger' : 'neutral'}
                data-testid="spend-drilldown-status-chip"
              >
                {bucket.isSpike ? 'Spike' : 'Normal'}
              </Chip>
            </>
          )}
        </Stack>

        {accounts && (
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <Stack gap={0.5} data-testid="spend-drilldown-providers">
              <Typography level="title-sm">By provider</Typography>
              {accounts.byProvider.map(p => (
                <ShareLine
                  key={p.provider}
                  label={providerLabel(p.provider)}
                  costUsd={p.costUsd}
                  total={total}
                  testId={`spend-drilldown-provider-${p.provider}`}
                />
              ))}
            </Stack>
            <Stack gap={0.5} data-testid="spend-drilldown-segments">
              <Typography level="title-sm">By account type</Typography>
              {accounts.bySegment.map(s => (
                <ShareLine
                  key={s.segment}
                  label={SEGMENT_LABELS[s.segment]}
                  costUsd={s.costUsd}
                  total={total}
                  testId={`spend-drilldown-segment-${s.segment}`}
                />
              ))}
            </Stack>
          </Box>
        )}

        <DataTable
          label="Top spenders"
          testId="spend-drilldown-accounts-table"
          rows={accounts?.accounts ?? []}
          columns={columns}
          getRowId={row => row.accountId}
          rowTestId={row => `spend-drilldown-account-row-${row.accountId}`}
          onRowActivate={onSelectAccount}
          loading={isLoading && !accounts}
          error={error}
          onRetry={onRetry}
          empty={
            <Typography level="body-sm">
              {total > 0 ? 'No user-attributed spend in this window.' : 'No recorded spend in this window.'}
            </Typography>
          }
          pagination={false}
          framed={false}
          minWidth="28rem"
        />
      </Stack>
    </SectionCard>
  );
}
