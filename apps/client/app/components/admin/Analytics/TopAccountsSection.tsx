import { Stack, Typography } from '@mui/joy';
import type { AnalyticsTopAccounts, TopAccountRow } from '@client/app/utils/analyticsOverview';
import { DataTable, InlineBar, StatusChip, type DataColumn } from '../shared';
import { PLAN_LABELS } from '../Users/List/usersColumns';
import { AnalyticsSection } from './AnalyticsSection';
import { formatCount, formatShare } from './analyticsFormat';

type Kind = 'users' | 'orgs';

const TITLES: Record<Kind, string> = { users: 'Top users', orgs: 'Top organizations' };

type Props = {
  kind: Kind;
  data: AnalyticsTopAccounts | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onShowDefaultRange?: () => void;
  onOpen: (row: TopAccountRow) => void;
};

/** "3 suspected and 1 suspended account left out." or null when nothing was. */
export function excludedLine({ suspected, suspended }: AnalyticsTopAccounts['excluded']): string | null {
  const parts = [
    ...(suspected > 0 ? [`${formatCount(suspected)} suspected`] : []),
    ...(suspended > 0 ? [`${formatCount(suspended)} suspended`] : []),
  ];
  if (parts.length === 0) return null;
  const accounts = suspected + suspended === 1 ? 'account' : 'accounts';
  return `${parts.join(' and ')} ${accounts} left out.`;
}

export function TopAccountsSection({ kind, data, loading, error, onRetry, onShowDefaultRange, onOpen }: Props) {
  const rows = data?.[kind] ?? [];
  const maxShare = Math.max(0, ...rows.map(row => row.share));
  const covered = data?.covered;
  const excluded = data ? excludedLine(data.excluded) : null;
  const caption = covered
    ? `Ranked by active days, then AI requests, over ${covered.from} to ${covered.to} (complete UTC days).${
        excluded ? ` ${excluded}` : ''
      }${kind === 'orgs' ? ' Org numbers add up the usage of members working in the org.' : ''}`
    : undefined;

  const columns: DataColumn<TopAccountRow>[] = [
    {
      id: 'name',
      label: kind === 'users' ? 'User' : 'Organization',
      sortValue: row => row.name.toLowerCase(),
      render: row => (
        <Typography level="body-sm" noWrap sx={{ color: 'admin.ink', maxWidth: '14rem' }} title={row.name}>
          {row.name}
        </Typography>
      ),
    },
    {
      id: 'plan',
      label: 'Plan',
      sortValue: row => row.plan ?? '',
      render: row =>
        row.plan ? (
          <StatusChip
            tone={row.plan === 'Free' || row.plan === 'DemoUser' ? 'neutral' : 'info'}
            label={PLAN_LABELS[row.plan] ?? row.plan}
            data-testid={`analytics-top-${kind}-plan-${row.id}`}
          />
        ) : (
          '-'
        ),
    },
    {
      id: 'activeDays',
      label: 'Active days',
      numeric: true,
      sortValue: row => row.activeDays,
      render: row => formatCount(row.activeDays),
    },
    {
      id: 'requests',
      label: 'AI requests',
      numeric: true,
      sortValue: row => row.requests,
      render: row => formatCount(row.requests),
    },
    {
      id: 'credits',
      label: 'Credits',
      numeric: true,
      sortValue: row => row.credits,
      render: row => formatCount(row.credits),
    },
    {
      id: 'share',
      label: 'Share of all requests',
      numeric: true,
      sortValue: row => row.share,
      render: row => (
        <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={1}>
          <InlineBar value={row.share} max={maxShare} />
          <Typography level="body-sm">{formatShare(row.share)}</Typography>
        </Stack>
      ),
    },
  ];

  return (
    <AnalyticsSection
      title={TITLES[kind]}
      caption={caption}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={rows.length === 0}
      onShowDefaultRange={onShowDefaultRange}
      chart={
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={row => row.id}
          label={TITLES[kind]}
          onRetry={onRetry}
          onRowActivate={onOpen}
          pagination={false}
          minWidth="36rem"
          testId={`analytics-top-${kind}-table`}
          rowTestId={row => `analytics-top-${kind}-row-${row.id}`}
        />
      }
      testId={`analytics-top-${kind}`}
    />
  );
}
