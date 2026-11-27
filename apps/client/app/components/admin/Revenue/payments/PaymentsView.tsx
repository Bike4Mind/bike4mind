import React, { useMemo, useState, type ReactNode } from 'react';
import { Alert, Box, Button, Input, MenuItem, Skeleton, Stack, Typography } from '@mui/joy';
import DownloadIcon from '@mui/icons-material/Download';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  ADMIN_PAYMENTS_EXPORT_MAX_ROWS,
  PAYMENT_STATUSES,
  toIsoDay,
  type AdminPaymentRow,
  type AdminPaymentsSummaryResponse,
  type PaymentsCoverage,
} from '@bike4mind/server-utils/app/utils/adminPayments';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { downloadData } from '@client/app/utils/download';
import { AnalyticsTermHelp } from '../../EventMetrics/components/AnalyticsTermHelp';
import { ADMIN_ORGANIZATIONS_TAB_SLUG, adminSearchForTab } from '../../adminTabParams';
import { ORGS_ORG_ID_PARAM } from '../../organizationsTabSearch';
import {
  AdminSearchInput,
  DataTable,
  EmptyState,
  ErrorState,
  FilterChip,
  FilterInputLabel,
  FilterToolbar,
  SectionCard,
  SegmentedControl,
  StatStrip,
  StatTile,
  formatMoney,
  type DataColumn,
} from '../../shared';
import { Dash } from '../../shared/Dash';
import { UpdatingBar } from '../../shared/LoadingState';
import { ADMIN_REGION_GAP, adminFocus } from '../../shared/adminStyles';
import { formatLongDay } from '../revenueFormat';
import {
  CLEARED_PAYMENTS_FILTERS,
  hasPaymentsFilters,
  parseIsoDay,
  parseMajorAmount,
  paymentsApiFilter,
  paymentsParamsError,
  type PaymentsParams,
} from '../revenueTabSearch';
import { PaymentsChart } from './PaymentsChart';
import { paymentsColumns } from './paymentsColumns';
import { PAYMENT_STATUS_DISPLAY } from './paymentStatusTone';
import {
  breakdownRows,
  chartPoints,
  grossOf,
  negate,
  refundsAndDisputesOf,
  summaryCurrency,
  totalsIn,
  type BreakdownRow,
} from './paymentsSummary';
import { usePaymentsParams } from './usePaymentsTabParams';
import { fetchPaymentsExport, useAdminPaymentsList, useAdminPaymentsSummary } from './useAdminPayments';
import { RowActionsMenu } from '../../shared/RowActionsMenu';

const DAY_MS = 86_400_000;
const SEARCH_DEBOUNCE_MS = 250;

const KIND_OPTIONS = [
  { value: 'subscription', label: 'Subscriptions' },
  { value: 'credit_purchase', label: 'Credit purchases' },
] as const;
const STATUS_OPTIONS = PAYMENT_STATUSES.map(status => ({ value: status, label: PAYMENT_STATUS_DISPLAY[status].label }));
const OWNER_OPTIONS = [
  { value: 'user', label: 'Individuals' },
  { value: 'organization', label: 'Organizations' },
] as const;

const GROSS_DEFINITION =
  'Subscription payments plus credit purchases charged in the range, as charged to the customer. Stripe fees are not deducted. The totals ignore the status and amount filters, which narrow the table only.';
const NET_DEFINITION =
  'Gross minus refunds and lost disputes. A refund or dispute counts on the day it happened, whenever the payment was made.';
const PAYERS_DEFINITION =
  'Distinct customers with a successful payment in the range. An organization counts once, however many payments it made.';
const BUYERS_DEFINITION =
  'Customers who bought credits in the range. First-time buyers had no completed purchase before it; repeat buyers did.';

const Skeletal = () => <Skeleton variant="text" level="h3" width="4ch" data-testid="admin-stat-skeleton" />;

const lastDays = (days: number, now: Date) => ({
  from: toIsoDay(new Date(now.getTime() - (days - 1) * DAY_MS)),
  to: toIsoDay(now),
});

function signedDelta(current: number, previous: number, currency: string): string {
  const delta = current - previous;
  if (delta === 0) return 'No change from the previous period';
  const formatted = formatMoney(delta, currency);
  return `${delta > 0 ? '+' : ''}${formatted} vs previous period`;
}

function CoverageNote({ coverage }: { coverage: PaymentsCoverage }) {
  if (coverage.stripeEvents === 'complete') return null;
  const text =
    coverage.stripeEvents === 'partial' && coverage.recordedFrom
      ? `Subscription payments, refunds and disputes are recorded from ${formatLongDay(coverage.recordedFrom.slice(0, 10))}. Earlier ones are not included.`
      : 'Subscription payments, refunds and disputes were not recorded for this range, so subscription and net totals are unknown.';
  return (
    <Alert color="neutral" variant="soft" data-testid="admin-payments-coverage-note">
      {text}
    </Alert>
  );
}

function PaymentsStrip({
  summary,
  currency,
  isError,
}: {
  summary?: AdminPaymentsSummaryResponse;
  currency: string;
  isError: boolean;
}) {
  const current = summary ? totalsIn(summary.current, currency) : undefined;
  const previous = summary ? totalsIn(summary.previous, currency) : undefined;
  const pending = isError ? <Dash /> : <Skeletal />;
  const compact = (amount: number) => formatMoney(amount, currency, { compact: true });
  // Unknown is a muted dash, never $0 (DESIGN_GUIDE "Money").
  const knownMoney = (amount: number | null, testId: string) =>
    amount === null ? <Dash title="Not recorded for this range" data-testid={testId} /> : compact(amount);
  const gross = current ? grossOf(current) : null;
  const previousGross = previous ? grossOf(previous) : null;
  const payers = summary?.current.payers;
  const buyers = summary?.current.creditBuyers;
  return (
    <StatStrip aria-label="Payments totals">
      <StatTile
        label="Gross"
        help={<AnalyticsTermHelp term="Gross" testId="admin-payments-gross-help-btn" description={GROSS_DEFINITION} />}
        value={current ? knownMoney(gross, 'admin-payments-gross-unknown') : pending}
        comparison={gross !== null && previousGross !== null ? signedDelta(gross, previousGross, currency) : undefined}
      />
      <StatTile
        label="Refunds & disputes"
        value={current ? compact(negate(refundsAndDisputesOf(current))) : pending}
        comparison={
          current
            ? `${formatMoney(negate(current.refunds), currency)} refunds, ${formatMoney(negate(current.disputeLosses), currency)} lost disputes`
            : undefined
        }
      />
      <StatTile
        label="Net"
        help={<AnalyticsTermHelp term="Net" testId="admin-payments-net-help-btn" description={NET_DEFINITION} />}
        value={current ? knownMoney(current.net, 'admin-payments-net-unknown') : pending}
        comparison={
          current?.net != null && previous?.net != null ? signedDelta(current.net, previous.net, currency) : undefined
        }
      />
      <StatTile
        label="Paying customers"
        help={
          <AnalyticsTermHelp
            term="Paying customers"
            testId="admin-payments-payers-help-btn"
            description={PAYERS_DEFINITION}
          />
        }
        value={payers ? payers.total : pending}
        comparison={
          payers
            ? `${payers.subscriptionOnly.toLocaleString()} subscription only, ${payers.creditOnly.toLocaleString()} credit only, ${payers.both.toLocaleString()} both`
            : undefined
        }
      />
      <StatTile
        label="Credit buyers"
        help={
          <AnalyticsTermHelp
            term="Credit buyers"
            testId="admin-payments-buyers-help-btn"
            description={BUYERS_DEFINITION}
          />
        }
        value={buyers ? buyers.buyers : pending}
        comparison={
          buyers
            ? `${buyers.firstTime.toLocaleString()} first-time, ${buyers.repeat.toLocaleString()} repeat`
            : undefined
        }
      />
    </StatStrip>
  );
}

function breakdownColumns(currency: string): DataColumn<BreakdownRow>[] {
  const code = currency.toUpperCase();
  const amount = (value: number | null, row: BreakdownRow) =>
    value === null ? (
      <Dash title="Unknown" />
    ) : (
      <Box component="span" sx={{ fontWeight: row.total ? 600 : 400 }}>
        {formatMoney(value, currency)}
      </Box>
    );
  return [
    {
      id: 'item',
      label: 'Item',
      render: row => (
        <Box component="span" sx={{ fontWeight: row.total ? 600 : 400 }}>
          {row.label}
        </Box>
      ),
    },
    { id: 'current', label: `This period (${code})`, numeric: true, render: row => amount(row.current, row) },
    { id: 'previous', label: `Previous period (${code})`, numeric: true, render: row => amount(row.previous, row) },
    {
      id: 'count',
      label: 'Payments',
      numeric: true,
      render: row =>
        row.count === undefined ? '' : row.count === null ? <Dash title="Unknown" /> : row.count.toLocaleString(),
    },
  ];
}

function SummarySections({
  summary,
  currency,
  loading,
}: {
  summary?: AdminPaymentsSummaryResponse;
  currency: string;
  loading: boolean;
}) {
  const [asTable, setAsTable] = useState(false);
  const rows = useMemo(
    () => (summary ? breakdownRows(totalsIn(summary.current, currency), totalsIn(summary.previous, currency)) : []),
    [summary, currency]
  );
  const points = useMemo(() => (summary ? chartPoints(summary, currency) : []), [summary, currency]);
  const columns = useMemo(() => breakdownColumns(currency), [currency]);
  const code = currency.toUpperCase();
  const skeleton = (testId: string) => (
    <Box sx={{ p: 2 }}>
      <Skeleton variant="rectangular" height={220} sx={{ borderRadius: '8px' }} data-testid={testId} />
    </Box>
  );
  const pointColumns: DataColumn<(typeof points)[number]>[] = [
    { id: 'date', label: summary?.bucket === 'month' ? 'Month (UTC)' : 'Date (UTC)', render: point => point.label },
    {
      id: 'subscription',
      label: `Subscriptions (${code})`,
      numeric: true,
      render: point => formatMoney(point.subscription, currency),
    },
    {
      id: 'credit',
      label: `Credit purchases (${code})`,
      numeric: true,
      render: point => formatMoney(point.creditPurchase, currency),
    },
  ];
  let chartBody: ReactNode;
  if (!summary || loading) chartBody = skeleton('admin-payments-chart-skeleton');
  else if (points.length === 0)
    chartBody = (
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted', p: 2 }} data-testid="admin-payments-chart-empty">
        No payments in this range.
      </Typography>
    );
  else
    chartBody = (
      <Box sx={{ p: 2 }}>
        {asTable ? (
          <DataTable
            label="Payments over time"
            testId="admin-payments-chart-table"
            rows={points}
            columns={pointColumns}
            getRowId={point => point.date}
            onRetry={() => undefined}
            pagination={false}
            minWidth="24rem"
          />
        ) : (
          <PaymentsChart points={points} currency={currency} />
        )}
      </Box>
    );
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, minWidth: 0 }}>
      <SectionCard title="Breakdown" body="custom" data-testid="admin-payments-breakdown">
        {!summary ? (
          skeleton('admin-payments-breakdown-skeleton')
        ) : (
          <DataTable
            label="Breakdown"
            testId="admin-payments-breakdown-table"
            rows={rows}
            columns={columns}
            getRowId={row => row.id}
            rowTestId={row => `admin-payments-breakdown-row-${row.id}`}
            onRetry={() => undefined}
            pagination={false}
            minWidth="28rem"
            maxHeight="none"
          />
        )}
      </SectionCard>
      <SectionCard
        title="Payments over time"
        body="custom"
        data-testid="admin-payments-over-time"
        action={
          points.length > 0 && (
            <Button
              size="sm"
              variant="plain"
              onClick={() => setAsTable(previous => !previous)}
              aria-pressed={asTable}
              data-testid="admin-payments-chart-table-toggle-btn"
              sx={adminFocus}
            >
              {asTable ? 'View as chart' : 'View as table'}
            </Button>
          )
        }
      >
        {chartBody}
      </SectionCard>
    </Box>
  );
}

function PaymentRowActions({
  row,
  onOpenCustomer,
  onOpenSubscription,
}: {
  row: AdminPaymentRow;
  onOpenCustomer: () => void;
  onOpenSubscription: () => void;
}) {
  if (!row.owner && !row.subscriptionId) return null;
  return (
    <RowActionsMenu testId={`admin-payments-row-actions-${row.id}`} ariaLabel="Actions for this payment" stopRowClick>
      {row.owner && (
        <MenuItem onClick={onOpenCustomer} data-testid={`admin-payments-row-open-customer-${row.id}`}>
          Open customer
        </MenuItem>
      )}
      {row.subscriptionId && (
        <MenuItem onClick={onOpenSubscription} data-testid={`admin-payments-row-open-subscription-${row.id}`}>
          Open subscription
        </MenuItem>
      )}
    </RowActionsMenu>
  );
}

const amountInputSx = { width: '9.5rem' };

function PaymentsToolbar({
  params,
  setParams,
  search,
  onSearch,
  currencies,
  filtered,
  onClear,
  onExport,
  exporting,
  exportDisabled,
}: {
  params: PaymentsParams;
  setParams: (patch: Partial<PaymentsParams>) => void;
  search: string;
  onSearch: (value: string) => void;
  currencies: readonly string[];
  filtered: boolean;
  onClear: () => void;
  onExport: () => void;
  exporting: boolean;
  exportDisabled: boolean;
}) {
  const narrow = (patch: Partial<PaymentsParams>) => setParams({ ...patch, page: 1 });
  const amountInput = (key: 'minAmount' | 'maxAmount', label: string) => (
    <Input
      type="number"
      size="sm"
      value={params[key] ?? ''}
      startDecorator={<FilterInputLabel>{label}</FilterInputLabel>}
      slotProps={{
        input: { min: 0, step: '0.01', 'aria-label': `${label} amount`, 'data-testid': `admin-payments-${key}-input` },
      }}
      onChange={event => narrow({ [key]: parseMajorAmount(event.target.value) })}
      sx={{ ...adminFocus, ...amountInputSx }}
    />
  );
  return (
    <FilterToolbar data-testid="admin-payments-toolbar">
      <Box sx={{ display: 'flex', flex: '1 1 240px', minWidth: 240, maxWidth: '26rem' }}>
        <AdminSearchInput
          value={search}
          onChange={onSearch}
          label="Search name, email, owner id, pi_ or in_"
          data-testid="admin-payments-search-input"
        />
      </Box>
      <Input
        type="date"
        size="sm"
        value={params.from}
        startDecorator={<FilterInputLabel>From</FilterInputLabel>}
        slotProps={{ input: { 'aria-label': 'From date (UTC)', 'data-testid': 'admin-payments-from-input' } }}
        onChange={event => narrow({ from: parseIsoDay(event.target.value) })}
        sx={adminFocus}
      />
      <Input
        type="date"
        size="sm"
        value={params.to}
        startDecorator={<FilterInputLabel>To</FilterInputLabel>}
        slotProps={{ input: { 'aria-label': 'To date (UTC)', 'data-testid': 'admin-payments-to-input' } }}
        onChange={event => narrow({ to: parseIsoDay(event.target.value) })}
        sx={adminFocus}
      />
      <FilterChip
        id="payments-kind"
        label="Type"
        options={KIND_OPTIONS}
        value={params.kind}
        onChange={value => narrow({ kind: KIND_OPTIONS.find(option => option.value === value)?.value })}
      />
      <FilterChip
        id="payments-status"
        label="Status"
        options={STATUS_OPTIONS}
        value={params.status}
        onChange={value => narrow({ status: PAYMENT_STATUSES.find(status => status === value) })}
      />
      <FilterChip
        id="payments-owner"
        label="Owner"
        options={OWNER_OPTIONS}
        value={params.ownerType}
        onChange={value => narrow({ ownerType: OWNER_OPTIONS.find(option => option.value === value)?.value })}
      />
      <FilterChip
        id="payments-currency"
        label="Currency"
        options={currencies.map(code => ({ value: code, label: code.toUpperCase() }))}
        value={params.currency}
        onChange={value => narrow({ currency: value })}
      />
      {amountInput('minAmount', 'Min')}
      {amountInput('maxAmount', 'Max')}
      {filtered && (
        <Button
          size="sm"
          variant="plain"
          onClick={onClear}
          data-testid="admin-payments-clear-filters-btn"
          sx={adminFocus}
        >
          Clear filters
        </Button>
      )}
      <Button
        size="sm"
        variant="outlined"
        startDecorator={<DownloadIcon />}
        loading={exporting}
        disabled={exportDisabled}
        onClick={onExport}
        data-testid="admin-payments-export-btn"
        sx={{ ...adminFocus, ml: 'auto' }}
      >
        Export CSV
      </Button>
    </FilterToolbar>
  );
}

/** Revenue > Payments: credit purchases and subscription payments, cash basis. Read-only. */
export function PaymentsView() {
  const [params, setParams] = usePaymentsParams();
  const navigate = useNavigate();
  const {
    value: search,
    debouncedValue: debouncedSearch,
    setValue: setSearch,
    setValueImmediately: setSearchImmediately,
  } = useDebounceValue('', SEARCH_DEBOUNCE_MS);
  const [pickedCurrency, setPickedCurrency] = useState<string>();
  const [exporting, setExporting] = useState(false);

  const paramsError = paymentsParamsError(params);
  const filter = useMemo(() => paymentsApiFilter(params, debouncedSearch), [params, debouncedSearch]);
  const listQuery = useMemo(() => ({ ...filter, page: params.page, limit: params.limit }), [filter, params]);
  const summaryQuery = useAdminPaymentsSummary(filter, { enabled: paramsError === null });
  const list = useAdminPaymentsList(listQuery, { enabled: paramsError === null });

  const summary = summaryQuery.data;
  const currentTotals = summary?.current.totals;
  const summaryCurrencies = useMemo(
    () => [...new Set(currentTotals?.map(entry => entry.currency) ?? [])],
    [currentTotals]
  );
  const currency = summaryCurrency(summaryCurrencies, pickedCurrency, params.currency);
  const filterCurrencies = [...new Set(['usd', ...(params.currency ? [params.currency] : []), ...summaryCurrencies])];
  const filtered = hasPaymentsFilters(params, search);
  const narrowsTableOnly =
    params.status !== undefined || params.minAmount !== undefined || params.maxAmount !== undefined;

  const onSearch = (value: string) => {
    setSearch(value);
    if (params.page !== 1) setParams({ page: 1 });
  };
  const clearFilters = () => {
    setSearchImmediately('');
    setParams({ ...CLEARED_PAYMENTS_FILTERS, page: 1 });
  };
  const showLastYear = () => setParams({ ...lastDays(365, new Date()), page: 1 });

  const openCustomer = (row: AdminPaymentRow) => {
    if (!row.owner) return;
    if (row.owner.kind === 'user') {
      void navigate({ to: '/admin/users/$userId', params: { userId: row.owner.id } });
      return;
    }
    const orgId = row.owner.id;
    void navigate({
      to: '/admin',
      search: (previous: Record<string, unknown>) => ({
        ...adminSearchForTab(previous, ADMIN_ORGANIZATIONS_TAB_SLUG),
        [ORGS_ORG_ID_PARAM]: orgId,
      }),
    });
  };
  const openSubscription = (row: AdminPaymentRow) => {
    if (!row.subscriptionId) return;
    void navigate({
      to: '/admin/subscriptions/by-stripe/$stripeSubscriptionId',
      params: { stripeSubscriptionId: row.subscriptionId },
    });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await fetchPaymentsExport(filter);
      downloadData(result.blob, result.fileName, 'text/csv;charset=utf-8;');
      if (result.truncated) {
        toast.warning(
          `The export stopped at ${ADMIN_PAYMENTS_EXPORT_MAX_ROWS.toLocaleString('en-US')} rows. Narrow the range to get the rest.`
        );
      }
      if (result.searchTruncated)
        toast.warning('The search matched too many customers. Narrow it to export every match.');
    } catch (error) {
      console.error('Failed to export payments CSV:', error);
      toast.error('Failed to download the payments CSV.');
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo(() => paymentsColumns(), []);
  const searchTruncated = Boolean(list.data?.searchTruncated || summary?.searchTruncated);
  const listLoading = paramsError === null && list.isLoading;

  const empty = filtered ? (
    <EmptyState
      title="No payments match these filters"
      action={
        <Button variant="outlined" onClick={clearFilters} data-testid="admin-payments-empty-clear-btn">
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      title="No payments in this range"
      description={`Nothing was charged from ${formatLongDay(params.from)} to ${formatLongDay(params.to)}.`}
      action={
        <Button variant="outlined" onClick={showLastYear} data-testid="admin-payments-empty-widen-btn">
          Show last 12 months
        </Button>
      }
    />
  );

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-payments-view">
      <PaymentsToolbar
        params={params}
        setParams={setParams}
        search={search}
        onSearch={onSearch}
        currencies={filterCurrencies}
        filtered={filtered}
        onClear={clearFilters}
        onExport={() => void handleExport()}
        exporting={exporting}
        exportDisabled={paramsError !== null}
      />
      {paramsError ? (
        <Alert color="warning" data-testid="admin-payments-params-error">
          {paramsError}
        </Alert>
      ) : (
        <>
          {summary && <CoverageNote coverage={summary.current.coverage} />}
          {searchTruncated && (
            <Alert color="warning" data-testid="admin-payments-search-truncated">
              This search matches more customers than the page can resolve. Narrow it to see every match.
            </Alert>
          )}
          {summaryQuery.isError && !summary ? (
            <ErrorState message="Could not load the payment totals." onRetry={() => void summaryQuery.refetch()} />
          ) : (
            <Stack gap={1.5} sx={{ minWidth: 0 }}>
              {summaryCurrencies.length > 1 && (
                <SegmentedControl
                  options={summaryCurrencies.map(code => ({ value: code, label: code.toUpperCase() }))}
                  value={currency}
                  onChange={setPickedCurrency}
                  aria-label="Totals currency"
                  data-testid="admin-payments-currency"
                />
              )}
              <PaymentsStrip summary={summary} currency={currency} isError={summaryQuery.isError} />
              {narrowsTableOnly && (
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="admin-payments-totals-scope">
                  The totals ignore the status and amount filters, which narrow the table only.
                </Typography>
              )}
            </Stack>
          )}
          <SummarySections
            summary={summary}
            currency={currency}
            loading={summaryQuery.isPlaceholderData && summaryQuery.isFetching}
          />
          <Stack gap={0.5} sx={{ minWidth: 0 }}>
            <UpdatingBar active={list.isFetching && !list.isLoading} testId="admin-payments-updating" />
            <DataTable
              label="Payments"
              testId="admin-payments-table"
              rows={list.data?.payments ?? []}
              columns={columns}
              getRowId={row => row.id}
              rowTestId={row => `admin-payments-row-${row.id}`}
              loading={listLoading}
              error={list.isError && !list.data ? 'Could not load payments.' : undefined}
              onRetry={() => void list.refetch()}
              onRowActivate={openCustomer}
              rowActions={row => (
                <PaymentRowActions
                  row={row}
                  onOpenCustomer={() => openCustomer(row)}
                  onOpenSubscription={() => openSubscription(row)}
                />
              )}
              empty={empty}
              pagination={{
                page: params.page,
                pageSize: params.limit,
                total: list.data?.total ?? 0,
                onPageChange: page => setParams({ page }),
                onPageSizeChange: limit => setParams({ limit, page: 1 }),
              }}
              minWidth="60rem"
              maxHeight="none"
            />
          </Stack>
        </>
      )}
    </Stack>
  );
}
