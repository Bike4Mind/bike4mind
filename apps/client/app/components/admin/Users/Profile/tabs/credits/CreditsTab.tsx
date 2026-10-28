import React, { useMemo, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { toast } from 'sonner';
import { ADMIN_LEDGER_EXPORT_MAX_ROWS, type AdminCreditSummary, type AdminLedgerRow } from '@bike4mind/common';
import {
  fetchCreditLedgerExport,
  useAdminCreditLedger,
  useAdminCreditSummary,
} from '@client/app/hooks/data/adminUserCredits';
import {
  DataTable,
  ErrorState,
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
import { SpendChart } from './SpendChart';
import {
  LEDGER_FILTER_OPTIONS,
  SPEND_RANGE_OPTIONS,
  ledgerRowDetail,
  ledgerTypeChip,
  spendWindow,
  type LedgerFilter,
  type SpendRange,
} from './creditLedgerModel';

const DASH = '-';

const Muted: React.FC<{ children: React.ReactNode; 'data-testid'?: string }> = ({ children, ...rest }) => (
  <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }} {...rest}>
    {children}
  </Typography>
);

const CREDITS_PER_DAY_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

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
  {
    id: 'model',
    label: 'Model',
    render: row =>
      row.model ? (
        <Box
          component="span"
          title={row.model}
          sx={{
            display: 'block',
            fontFamily: 'code',
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.model}
        </Box>
      ) : (
        DASH
      ),
  },
  { id: 'source', label: 'Source', render: row => row.source ?? DASH },
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

const SpendCard: React.FC<{ summary: ReturnType<typeof useAdminCreditSummary> }> = ({ summary }) => {
  const [range, setRange] = useState<SpendRange>('30');
  const points = useMemo(() => (summary.data ? spendWindow(summary.data.daily, range) : []), [summary.data, range]);
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
        <SpendChart points={points} />
      </Stack>
    );
  };

  return (
    <SectionCard
      title="Spend over time"
      body="custom"
      data-testid="user-credits-spend"
      action={
        <SegmentedControl
          options={SPEND_RANGE_OPTIONS}
          value={range}
          onChange={setRange}
          aria-label="Spend range"
          data-testid="user-credits-range"
        />
      }
    >
      {body()}
    </SectionCard>
  );
};

/** Credit balance, spend and the full ledger. Adjusting credits opens the profile's shared dialog. */
export const CreditsTab: React.FC<{ user: AdminUserProfile; onAdjust: () => void }> = ({ user, onAdjust }) => {
  const summary = useAdminCreditSummary(user.id);
  const [filter, setFilter] = useState<LedgerFilter>('all');
  const kind = filter === 'all' ? undefined : filter;
  const ledger = useAdminCreditLedger(user.id, kind);
  const rows = useMemo(() => ledger.data?.pages.flatMap(page => page.rows) ?? [], [ledger.data]);
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await fetchCreditLedgerExport(user.id, kind);
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
            value={filter}
            onChange={setFilter}
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
              onClick={() => void exportCsv()}
              data-testid="user-credits-export-btn"
              sx={{ flexShrink: 0 }}
            >
              Export CSV
            </Button>
          </Stack>
        </Stack>
        <DataTable
          rows={rows}
          columns={LEDGER_COLUMNS}
          getRowId={row => row.id}
          label="Credit ledger"
          loading={ledger.isLoading}
          error={ledger.isError ? 'The ledger could not be loaded.' : undefined}
          onRetry={() => void ledger.refetch()}
          empty={<Muted>{kind ? 'No transactions of this type.' : 'No credit transactions yet.'}</Muted>}
          testId="user-credits-table"
          pageResetKey={filter}
        />
        {(ledger.hasNextPage || kind) && rows.length > 0 && (
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            gap={1}
            sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: 'admin.border' }}
          >
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {kind
                ? 'Balance shows on admin adjustments only while a filter is on.'
                : `${rows.length.toLocaleString('en-US')} newest transactions loaded`}
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
