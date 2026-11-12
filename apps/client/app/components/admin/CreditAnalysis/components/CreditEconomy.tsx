import { useEffect, useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  ECONOMY_FLOWS,
  ECONOMY_FLOW_LABELS,
  EconomyQuery,
  EconomyReport,
  EconomyPage,
} from '@client/shared/creditEconomy';
import {
  AdminPageHeader,
  DataTable,
  FilterBar,
  SectionCard,
  Fact,
  StatStrip,
  StatTile,
  ErrorState,
  LoadingState,
  EmptyState,
  UpdatingBar,
} from '../../shared';
import { useAdminListUrlState } from '../../shared/useAdminListUrlState';
import { ECONOMY_SEARCH_KEYS } from '../economySearch';
import { DateFilterComponent } from '../../EventMetrics/UserActivity/filters/DateFilterComponent';

export function CreditEconomy() {
  const [anchor] = useState(() => new Date().toISOString());
  const [state, update] = useAdminListUrlState(ECONOMY_SEARCH_KEYS);
  const [paging, setPaging] = useState({ page: 1, limit: 25 });
  const from = state.filters.from || new Date(Date.parse(anchor) - 30 * 86400000).toISOString();
  const to = state.filters.to || anchor;
  const parsed = EconomyQuery.safeParse({
    from,
    to,
    ownerType: state.filters.owner || 'all',
    flow: state.filters.flow || undefined,
    ...paging,
  });
  const params = parsed.success ? parsed.data : undefined;
  const summary = useQuery({
    queryKey: ['admin', 'credit-economy', from, to, params?.ownerType],
    enabled: !!params,
    queryFn: async () =>
      EconomyReport.parse(
        (await api.get('/api/admin/credit-economy', { params: { from, to, ownerType: params?.ownerType } })).data
      ),
  });
  const page = useQuery({
    queryKey: ['admin', 'credit-economy-transactions', params],
    enabled: !!params,
    queryFn: async () =>
      EconomyPage.parse(
        (await api.get('/api/admin/credit-economy', { params: { ...params, view: 'transactions' } })).data
      ),
  });
  const data = summary.data;
  const setFilters = (filters: Record<string, string>) => {
    setPaging(previous => ({ ...previous, page: 1 }));
    update({ view: 'economy', filters: { ...state.filters, from, to, ...filters } });
  };
  useEffect(() => {
    if (!state.filters.from || !state.filters.to) {
      update({ view: 'economy', filters: { ...state.filters, from, to } });
    }
  }, [from, to, state.filters, update]);
  return (
    <Stack gap={3} data-testid="credit-economy">
      <AdminPageHeader
        level="section"
        title="Credit economy"
        description="Credit movement and source coverage, separate from money and pricing."
        actions={
          <Button
            data-testid="economy-export-btn"
            variant="outlined"
            disabled={!data || summary.isFetching || !!summary.error}
            onClick={() => {
              if (!data) return;
              const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = 'credit-economy.json';
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export report (JSON)
          </Button>
        }
      />
      <FilterBar
        search={false}
        state={{ ...state, filters: { owner: state.filters.owner, flow: state.filters.flow } }}
        filters={[
          {
            id: 'owner',
            label: 'Ownership',
            options: [
              { value: 'all', label: 'All owners' },
              { value: 'User', label: 'Individuals' },
              { value: 'Organization', label: 'Organizations' },
              { value: 'Agent', label: 'Agents' },
            ],
          },
          {
            id: 'flow',
            label: 'Transactions',
            options: ECONOMY_FLOWS.map(value => ({ value, label: ECONOMY_FLOW_LABELS[value] })),
          },
        ]}
        onChange={patch => {
          if (patch.filters) setFilters(patch.filters);
        }}
      />
      <Stack direction="row" gap={1} flexWrap="wrap">
        {[7, 30, 90, 365].map(days => (
          <Button
            key={days}
            variant="outlined"
            data-testid={`economy-window-${days}-btn`}
            onClick={() => {
              const end = new Date();
              setFilters({ from: new Date(end.getTime() - days * 86400000).toISOString(), to: end.toISOString() });
            }}
          >
            Last {days} days
          </Button>
        ))}
        <Button
          variant="plain"
          data-testid="economy-refresh-btn"
          onClick={() => {
            void summary.refetch();
            void page.refetch();
          }}
        >
          Refresh report
        </Button>
      </Stack>
      <DateFilterComponent
        value={{ startDate: from.slice(0, 10), endDate: to.slice(0, 10) }}
        onChange={range => {
          const start = new Date(`${range.startDate}T00:00:00Z`);
          const end = new Date(Math.min(Date.parse(`${range.endDate}T00:00:00Z`) + 86400000, Date.now()));
          if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
            setFilters({ from: start.toISOString(), to: end.toISOString() });
          }
        }}
      />
      <Typography level="body-sm">
        UTC window: {from} to {to} (end exclusive). Owner and date filters apply to the report; flow filters only the
        drill-down.
      </Typography>
      {!parsed.success && (
        <ErrorState
          message="Invalid shared filters. Choose a valid date window and owner."
          onRetry={() =>
            setFilters({
              from: new Date(Date.parse(anchor) - 30 * 86400000).toISOString(),
              to: anchor,
              owner: 'all',
              flow: '',
            })
          }
        />
      )}
      {summary.isLoading && <LoadingState label="Loading credit economy" />}
      <UpdatingBar active={summary.isFetching && !summary.isLoading} />
      {summary.error && <ErrorState message="Could not load credit economy." onRetry={() => void summary.refetch()} />}
      {data && !summary.error && (
        <>
          <StatStrip>
            <StatTile label="Net ledger movement (credits)" value={data.netMovement} />
            <StatTile label="Ledger transactions" value={data.transactionCount} />
            <StatTile
              label="Current available (credits)"
              value={data.balances.currentAvailable ?? 'Unavailable'}
              comparison={`As of ${data.asOf}; not the closing balance`}
            />
          </StatStrip>
          <DataTable
            label="Selected-period flows"
            testId="economy-flows-table"
            rows={data.flows}
            getRowId={row => row.flow}
            onRetry={() => void summary.refetch()}
            pagination={false}
            columns={[
              {
                id: 'flow',
                label: 'Flow',
                render: row => (
                  <Button
                    variant="plain"
                    data-testid={`economy-drill-${row.flow}-btn`}
                    onClick={() => setFilters({ flow: row.flow })}
                  >
                    {ECONOMY_FLOW_LABELS[row.flow]}
                  </Button>
                ),
              },
              { id: 'rows', label: 'Transactions', numeric: true, render: row => row.rows.toLocaleString() },
              { id: 'credits', label: 'Signed credits', numeric: true, render: row => row.credits.toLocaleString() },
            ]}
          />
          <SectionCard title="Reconciliation and balance coverage">
            <Fact label="Opening / closing">Unavailable / unavailable</Fact>
            <Fact label="Held / reserved">Unavailable</Fact>
            <Fact label="Independent difference">Unavailable (no historical snapshots)</Fact>
            <Fact label="Balance read coverage">
              {data.balances.holders} user/organization holders; {data.balances.missingBalances} missing balances
            </Fact>
            <Fact label="Ledger minus usage consumption">
              {data.funding.ledgerUsageDifference.toLocaleString()} credits unresolved
            </Fact>
            <Fact label="Funding stamp coverage">
              {data.funding.stampedRows} / {data.funding.usageRows} usage rows; {data.funding.invalidOrMissingRows}{' '}
              missing or invalid
            </Fact>
            <Fact label="Current live lots">{data.funding.lotCount}</Fact>
          </SectionCard>
          <DataTable
            label="Funding allocation"
            testId="economy-funding-table"
            rows={Object.entries(data.funding.consumption).map(([source, credits]) => ({
              source,
              credits,
              remaining: data.funding.currentLotRemainingEstimate[source as keyof typeof data.funding.consumption],
            }))}
            getRowId={row => row.source}
            onRetry={() => void summary.refetch()}
            pagination={false}
            columns={[
              { id: 'source', label: 'Funding', render: row => row.source },
              {
                id: 'consumed',
                label: 'Usage debited (credits)',
                numeric: true,
                render: row => row.credits.toLocaleString(),
              },
              {
                id: 'remaining',
                label: 'Current lot remainder estimate (credits)',
                numeric: true,
                render: row => row.remaining.toLocaleString(),
              },
            ]}
          />
          <DataTable
            label="Mature purchase cohorts"
            testId="economy-cohorts-table"
            rows={data.cohorts}
            getRowId={row => String(row.days)}
            onRetry={() => void summary.refetch()}
            pagination={false}
            columns={[
              { id: 'days', label: 'Horizon', render: row => `${row.days} days` },
              {
                id: 'purchases',
                label: 'Mature purchases',
                numeric: true,
                render: row => row.maturePurchases.toLocaleString(),
              },
              {
                id: 'issued',
                label: 'Original issued credits',
                numeric: true,
                render: row => row.issuedCredits.toLocaleString(),
              },
              { id: 'coverage', label: 'Attributable purchases', render: row => `0 / ${row.maturePurchases}` },
              { id: 'consumed', label: 'Consumed credits', render: () => 'Unavailable' },
            ]}
          />
          <SectionCard title="Definitions and limitations" body="custom">
            <Stack component="ul" gap={1} sx={{ pr: 2 }}>
              {data.limitations.map(text => (
                <Typography component="li" level="body-sm" key={text}>
                  {text}
                </Typography>
              ))}
            </Stack>
          </SectionCard>
        </>
      )}
      <DataTable
        label="Economy transactions"
        testId="economy-transactions-table"
        rows={page.data?.rows ?? []}
        getRowId={row => row.id}
        loading={page.isFetching}
        error={page.error ? 'Could not load economy transactions.' : undefined}
        onRetry={() => void page.refetch()}
        empty={
          <EmptyState
            title="No transactions match these filters"
            action={
              <Button data-testid="economy-clear-flow-btn" onClick={() => setFilters({ flow: '' })}>
                Clear transaction filter
              </Button>
            }
          />
        }
        pagination={{
          page: paging.page,
          pageSize: paging.limit,
          total: Math.min(page.data?.total ?? 0, 1000 * paging.limit),
          onPageChange: next => setPaging(previous => ({ ...previous, page: next })),
          onPageSizeChange: limit => setPaging({ page: 1, limit }),
        }}
        columns={[
          { id: 'at', label: 'When (UTC)', render: row => row.at },
          { id: 'id', label: 'Transaction', render: row => row.id },
          { id: 'owner', label: 'Owner', render: row => `${row.ownerType}: ${row.ownerId}` },
          { id: 'type', label: 'Type / reason', render: row => `${row.type}${row.reason ? ` / ${row.reason}` : ''}` },
          { id: 'flow', label: 'Flow', render: row => ECONOMY_FLOW_LABELS[row.flow] },
          { id: 'credits', label: 'Balance delta (credits)', numeric: true, render: row => row.delta.toLocaleString() },
        ]}
      />
      {(page.data?.total ?? 0) > 1000 * paging.limit && (
        <Typography level="body-sm">
          Drill-down is capped at 1,000 pages. Narrow the dates or ownership to inspect more transactions.
        </Typography>
      )}
    </Stack>
  );
}
