import React, { useMemo, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { toast } from 'sonner';
import {
  ADMIN_LEDGER_EXPORT_MAX_ROWS,
  isContiguousLedgerFilter,
  type AdminCreditSummary,
  type AdminLedgerRow,
} from '@bike4mind/common';
import {
  fetchCreditLedgerExport,
  useAdminCreditLedger,
  useAdminCreditSummary,
} from '@client/app/hooks/data/adminUserCredits';
import {
  DataTable,
  ErrorState,
  Fact,
  RelativeTime,
  SectionCard,
  SegmentedControl,
  StatStrip,
  StatTile,
  StatusChip,
  type DataColumn,
} from '../../../../shared';
import { formatCreditDelta, formatCredits } from '../../actions/creditAdjustment';
import type { AdminUserProfile } from '../../userProfileModel';
import { LedgerFilterBar } from './LedgerFilterBar';
import { SpendBreakdownChart, SpendChart } from './SpendChart';
import {
  EMPTY_LEDGER_FILTER,
  LEDGER_FILTER_OPTIONS,
  SPEND_RANGE_OPTIONS,
  SPEND_VIEW_OPTIONS,
  hasLedgerFilter,
  isLedgerRangeInverted,
  ledgerRowDetail,
  ledgerTypeChip,
  spendBreakdown,
  spendWindow,
  toLedgerQuery,
  type LedgerFilter,
  type LedgerFilterState,
  type SpendRange,
  type SpendView,
} from './creditLedgerModel';

const DASH = '-';

const Muted: React.FC<{ children: React.ReactNode; 'data-testid'?: string }> = ({ children, ...rest }) => (
  <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }} {...rest}>
    {children}
  </Typography>
);

const CREDITS_PER_DAY_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
// Provider cost of system work is often a fraction of a cent, so show up to four decimals.
const PROVIDER_USD_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
// The cap is an admin-typed value, so keep enough digits that a sub-cent cap never reads as $0.00.
const PROVIDER_CAP_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

/** One line of monospace text, cut with an ellipsis; the full value stays on hover. */
const CodeText: React.FC<{ text: string; title?: string }> = ({ text, title = text }) => (
  <Box
    component="span"
    title={title}
    sx={{
      display: 'block',
      fontFamily: 'code',
      fontSize: 12,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }}
  >
    {text}
  </Box>
);

const LEDGER_COLUMNS: readonly DataColumn<AdminLedgerRow>[] = [
  {
    id: 'when',
    label: 'When',
    render: row => <RelativeTime at={new Date(row.createdAt)} />,
    sortValue: row => row.createdAt,
  },
  {
    id: 'type',
    label: 'Type',
    render: row => {
      const chip = ledgerTypeChip(row);
      return <StatusChip tone={chip.tone} label={chip.label} />;
    },
  },
  {
    id: 'detail',
    label: 'Detail',
    render: row => {
      const detail = ledgerRowDetail(row);
      if (!detail) return DASH;
      // One line per row keeps the ledger scannable; the full text stays on hover.
      return (
        <Typography level="body-sm" noWrap title={detail} sx={{ color: 'inherit' }}>
          {detail}
        </Typography>
      );
    },
  },
  { id: 'model', label: 'Model', render: row => (row.model ? <CodeText text={row.model} /> : DASH) },
  { id: 'source', label: 'Source', render: row => row.source ?? DASH },
  {
    id: 'request',
    label: 'Request',
    render: row => {
      if (row.requestId) {
        const session = row.sessionId ? `\nSession id: ${row.sessionId}` : '';
        return <CodeText text={row.requestId} title={`API request id: ${row.requestId}${session}`} />;
      }
      if (row.questId) return <CodeText text={row.questId} title={`Chat message (quest) id: ${row.questId}`} />;
      return DASH;
    },
  },
  {
    id: 'change',
    label: 'Change',
    numeric: true,
    sortValue: row => row.credits,
    render: row => (
      <Box
        component="span"
        sx={{ color: row.credits > 0 ? 'admin.status.good.foreground' : 'admin.ink', fontWeight: 500 }}
      >
        {formatCreditDelta(row.credits)}
      </Box>
    ),
  },
  {
    id: 'balance',
    label: 'Balance',
    numeric: true,
    render: row => (row.balanceAfter === undefined ? DASH : formatCredits(row.balanceAfter)),
  },
];

const saveBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const TOP_UP_LABEL: Readonly<Record<'purchase' | 'subscription', string>> = {
  purchase: 'Purchase',
  subscription: 'Plan renewal',
};

const SummaryStrip: React.FC<{ summary: AdminCreditSummary | undefined; balance: number }> = ({ summary, balance }) => (
  <StatStrip aria-label="Credit summary">
    <StatTile label="Balance" value={formatCredits(summary?.balance ?? balance)} />
    <StatTile
      label="Spent, 7 days"
      value={summary ? formatCredits(summary.spent.last7d) : DASH}
      comparison={
        <span data-testid="user-credits-total-24h">
          {summary ? `${formatCredits(summary.spent.last24h)} in the last 24 hours` : DASH}
        </span>
      }
    />
    <StatTile
      label="Spent, 30 days"
      value={summary ? formatCredits(summary.spent.last30d) : DASH}
      comparison={summary ? `${CREDITS_PER_DAY_FORMAT.format(summary.spent.last30d / 30)} a day on average` : undefined}
    />
    <StatTile
      label="Top model, 30 days"
      value={
        summary?.topModel30d ? (
          <Box component="span" sx={{ fontSize: 16 }}>
            {summary.topModel30d.model}
          </Box>
        ) : (
          DASH
        )
      }
      comparison={summary?.topModel30d ? `${formatCredits(summary.topModel30d.credits)} credits` : undefined}
    />
    <StatTile
      label="Last top-up"
      value={summary?.lastTopUp ? formatCreditDelta(summary.lastTopUp.credits) : DASH}
      comparison={
        summary?.lastTopUp ? (
          <>
            {TOP_UP_LABEL[summary.lastTopUp.type]}, <RelativeTime at={new Date(summary.lastTopUp.at)} />
          </>
        ) : (
          'No purchases or renewals yet'
        )
      }
    />
  </StatStrip>
);

/** Provider cost of system-sourced work (file indexing, search, tool and session operations), charged or not. */
const SystemCostCard: React.FC<{ summary: AdminCreditSummary | undefined }> = ({ summary }) => {
  const cost = summary?.systemCost;
  const capOn = cost !== undefined && cost.dailyCapUsd > 0;
  const chip = !capOn ? undefined : !cost.capApplies ? (
    <StatusChip tone="neutral" label="Exempt from cap" />
  ) : cost.todayUsd >= cost.dailyCapUsd ? (
    <StatusChip tone="bad" label="Daily cap reached" />
  ) : undefined;
  return (
    <SectionCard title="System-sourced cost" data-testid="user-credits-system-cost" action={chip}>
      <Fact label="Today (UTC)" data-testid="user-credits-system-cost-today">
        {cost && PROVIDER_USD_FORMAT.format(cost.todayUsd)}
      </Fact>
      <Fact label="Last 7 days" data-testid="user-credits-system-cost-7d">
        {cost && PROVIDER_USD_FORMAT.format(cost.last7dUsd)}
      </Fact>
      <Fact label="Last 30 days" data-testid="user-credits-system-cost-30d">
        {cost && PROVIDER_USD_FORMAT.format(cost.last30dUsd)}
      </Fact>
      <Fact label="Free-tier daily cap" data-testid="user-credits-system-cost-cap">
        {cost && (cost.dailyCapUsd > 0 ? PROVIDER_CAP_FORMAT.format(cost.dailyCapUsd) : 'Off')}
      </Fact>
    </SectionCard>
  );
};

const SpendCard: React.FC<{ summary: ReturnType<typeof useAdminCreditSummary> }> = ({ summary }) => {
  const [range, setRange] = useState<SpendRange>('30');
  const [view, setView] = useState<SpendView>('day');
  const points = useMemo(() => (summary.data ? spendWindow(summary.data.daily, range) : []), [summary.data, range]);
  const bars = useMemo(() => {
    if (!summary.data || view === 'day') return [];
    return spendBreakdown(view === 'model' ? summary.data.byModel : summary.data.bySource, range, view);
  }, [summary.data, range, view]);
  // Every view shares one total: the breakdown windows are the same UTC days as the by-day series.
  const total = points.reduce((sum, point) => sum + point.credits, 0);

  const body = () => {
    if (summary.isLoading) return <Muted>Loading spend...</Muted>;
    if (summary.isError) {
      return <ErrorState message="Spend could not be loaded." onRetry={() => void summary.refetch()} />;
    }
    if (total === 0) {
      return <Muted data-testid="user-credits-chart-empty">No AI spend in the last {range} days.</Muted>;
    }
    return (
      <Stack gap={1} sx={{ p: 2 }}>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="user-credits-chart-total">
          {formatCredits(total)} credits over {range} days
        </Typography>
        {view === 'day' ? <SpendChart points={points} /> : <SpendBreakdownChart bars={bars} />}
      </Stack>
    );
  };

  return (
    <SectionCard
      title="Spend over time"
      body="custom"
      data-testid="user-credits-spend"
      action={
        <Stack direction="row" flexWrap="wrap" gap={1}>
          <SegmentedControl
            options={SPEND_VIEW_OPTIONS}
            value={view}
            onChange={setView}
            aria-label="Spend breakdown"
            data-testid="user-credits-view"
          />
          <SegmentedControl
            options={SPEND_RANGE_OPTIONS}
            value={range}
            onChange={setRange}
            aria-label="Spend range"
            data-testid="user-credits-range"
          />
        </Stack>
      }
    >
      {body()}
    </SectionCard>
  );
};

/** Credit balance, spend and the full ledger. Adjusting credits opens the profile's shared dialog. */
export const CreditsTab: React.FC<{ user: AdminUserProfile; onAdjust: () => void }> = ({ user, onAdjust }) => {
  const summary = useAdminCreditSummary(user.id);
  const [filter, setFilter] = useState<LedgerFilterState>(EMPTY_LEDGER_FILTER);
  const query = useMemo(() => toLedgerQuery(filter), [filter]);
  const rangeInverted = isLedgerRangeInverted(filter);
  const filtered = hasLedgerFilter(filter);
  const contiguous = isContiguousLedgerFilter(query);
  const ledger = useAdminCreditLedger(user.id, query, { enabled: !rangeInverted });
  const modelOptions = useMemo(
    () => (summary.data?.byModel ?? []).flatMap(bucket => (bucket.key ? [bucket.key] : [])),
    [summary.data]
  );
  const rows = useMemo(() => ledger.data?.pages.flatMap(page => page.rows) ?? [], [ledger.data]);
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await fetchCreditLedgerExport(user.id, query);
      saveBlob(file.blob, file.fileName);
      if (file.truncated) {
        toast.warning(
          `The export stopped at ${ADMIN_LEDGER_EXPORT_MAX_ROWS.toLocaleString('en-US')} rows. Narrow the filter to get the rest.`
        );
      }
    } catch {
      toast.error('The export failed. Try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Stack gap={2} data-testid="user-profile-credits">
      <SummaryStrip summary={summary.data} balance={user.currentCredits ?? 0} />
      <SpendCard summary={summary} />
      <SystemCostCard summary={summary.data} />
      <SectionCard
        title="Credit ledger"
        body="custom"
        data-testid="user-credits-ledger"
        action={
          <Button
            size="sm"
            variant="solid"
            color="primary"
            onClick={onAdjust}
            data-testid="user-profile-credits-adjust-btn"
          >
            Adjust credits
          </Button>
        }
      >
        <Stack
          direction="row"
          flexWrap="wrap"
          alignItems="center"
          justifyContent="space-between"
          gap={1}
          sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'admin.border' }}
        >
          <SegmentedControl
            options={LEDGER_FILTER_OPTIONS}
            value={filter.kind}
            onChange={(kind: LedgerFilter) => setFilter(current => ({ ...current, kind }))}
            aria-label="Transaction type"
            data-testid="user-credits-filter"
          />
          <Stack direction="row" alignItems="center" gap={1.5}>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="user-credits-export-cap">
              Exports the current filter, up to {ADMIN_LEDGER_EXPORT_MAX_ROWS.toLocaleString('en-US')} rows
            </Typography>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<FileDownloadOutlinedIcon sx={{ fontSize: 16 }} />}
              loading={exporting}
              disabled={rangeInverted}
              onClick={() => void exportCsv()}
              data-testid="user-credits-export-btn"
              sx={{ flexShrink: 0 }}
            >
              Export CSV
            </Button>
          </Stack>
        </Stack>
        <LedgerFilterBar value={filter} onChange={setFilter} modelOptions={modelOptions} />
        <DataTable
          rows={rows}
          columns={LEDGER_COLUMNS}
          getRowId={row => row.id}
          label="Credit ledger"
          loading={ledger.isLoading}
          error={ledger.isError ? 'The ledger could not be loaded.' : undefined}
          onRetry={() => void ledger.refetch()}
          empty={
            <Muted>
              {rangeInverted
                ? 'Fix the date range to see transactions.'
                : filtered
                  ? 'No transactions match these filters.'
                  : 'No credit transactions yet.'}
            </Muted>
          }
          testId="user-credits-table"
          pageResetKey={JSON.stringify(query)}
        />
        {(ledger.hasNextPage || !contiguous) && rows.length > 0 && (
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            gap={1}
            sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: 'admin.border' }}
          >
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {contiguous
                ? `${rows.length.toLocaleString('en-US')} transactions loaded, newest first`
                : 'Balance shows on admin adjustments only while a type, model or source filter is on.'}
            </Typography>
            {ledger.hasNextPage && (
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                loading={ledger.isFetchingNextPage}
                onClick={() => void ledger.fetchNextPage()}
                data-testid="user-credits-more-btn"
              >
                Load older
              </Button>
            )}
          </Stack>
        )}
      </SectionCard>
    </Stack>
  );
};
