import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import type { SideAppRow, SideAppUserRow } from '@client/shared/sideApps';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  StatStrip,
  StatTile,
} from '../../shared';
import { formatCredits } from '../utils/format';
import { zeroFillDailySeries } from '../utils/dailySeries';
import { downloadSideAppsCsv, downloadSideAppUsersCsv } from '../utils/sideAppsCsv';
import { useSideAppUsers, useSideApps } from '../hooks/useSideApps';
import { useCreditAnalysisStore } from '../store';
import { parseSideApp } from '../creditTabSearch';
import { DailyAreaChart } from './DailyAreaChart';
import ViewUserProfile from './ViewUserProfile';

const DAY_RANGES = [7, 30, 90, 365] as const;

const formatPercent = (fraction: number | null) => (fraction === null ? '-' : `${(fraction * 100).toFixed(1)}%`);
const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '-');

const TierMix: React.FC<{ tiers: SideAppRow['spend']['byTier'] }> = ({ tiers }) => (
  <Typography level="body-xs" sx={{ fontVariantNumeric: 'tabular-nums' }}>
    paid {formatCredits(tiers.paid)} / unpaid {formatCredits(tiers.unpaid)} / org {formatCredits(tiers.org)} /
    unrecorded {formatCredits(tiers.unrecorded)}
  </Typography>
);

interface RefusalLine {
  id: string;
  app: string;
  reason: string;
  refusalClass: string;
  count: number;
}

const UserTable: React.FC<{
  rows: SideAppUserRow[];
  onRetry: () => void;
}> = ({ rows, onRetry }) => (
  <DataTable
    label="Users of this app"
    testId="side-apps-user-table"
    rows={rows}
    getRowId={row => row.userId}
    pagination={false}
    maxHeight="480px"
    onRetry={onRetry}
    empty={<EmptyState title="No users in this window" action={null} />}
    columns={[
      {
        id: 'user',
        label: 'User',
        render: row => (
          <Stack direction="row" spacing={1} alignItems="center" data-testid={`side-apps-user-cell-${row.userId}`}>
            <Box sx={{ flex: 1, minWidth: 0 }} data-testid={`side-apps-user-text-${row.userId}`}>
              <Typography level="body-sm" noWrap title={row.name ?? undefined}>
                {row.name ?? 'Unknown user'}
              </Typography>
              {row.email && (
                <Typography level="body-xs" color="neutral" noWrap title={row.email}>
                  {row.email}
                </Typography>
              )}
            </Box>
            <Box sx={{ flexShrink: 0 }} data-testid={`side-apps-user-action-${row.userId}`}>
              <ViewUserProfile userId={row.userId} size="sm" />
            </Box>
          </Stack>
        ),
      },
      {
        id: 'tier',
        label: 'Tier now',
        render: row => (
          <Chip
            size="sm"
            variant="soft"
            color={row.currentTier === 'paid' ? 'success' : row.currentTier === 'unpaid' ? 'neutral' : 'warning'}
            data-testid={`side-apps-user-tier-${row.userId}`}
          >
            {row.currentTier}
          </Chip>
        ),
      },
      { id: 'credits', label: 'Credits', numeric: true, render: row => formatCredits(row.credits) },
      { id: 'mix', label: 'Recorded tier mix', render: row => <TierMix tiers={row.creditsByTier} /> },
      {
        id: 'requests',
        label: 'Requests',
        numeric: true,
        render: row => (
          <span title={row.requestsByEndpoint.map(entry => `${entry.endpoint}: ${entry.count}`).join('\n')}>
            {row.requests.toLocaleString()}
          </span>
        ),
      },
      { id: 'failed', label: 'Failed', numeric: true, render: row => row.failedRequests.toLocaleString() },
      { id: 'refusals', label: 'Refusals', numeric: true, render: row => row.refusals.toLocaleString() },
      { id: 'last', label: 'Last used', render: row => formatDate(row.lastUsedAt) },
      {
        id: 'models',
        label: 'Top models',
        render: row => (row.topModels.length ? row.topModels.map(model => model.model).join(', ') : '-'),
      },
    ]}
  />
);

/** Per connected app: spend by payer tier, requests, outcomes and refusals, with a per-user drill-down. */
export const SideAppsDashboard: React.FC = () => {
  const [days, setDays] = useState<number>(30);
  const storeClientId = useCreditAnalysisStore(state => state.sideAppClientId);
  const setStoreClientId = useCreditAnalysisStore(state => state.setSideAppClientId);
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const urlClientId = parseSideApp(search.sideApp);
  // An app handed over through the store (View usage) opens even with no activity in the window.
  const [handedOverId] = useState(storeClientId);
  const urlSeen = useRef(false);

  const { data, isLoading, isFetching, error, refetch } = useSideApps(days);
  const urlClientKnown = !!urlClientId && !!data?.apps.some(app => app.clientId === urlClientId);
  const clientId = urlClientId ? (urlClientKnown || urlClientId === handedOverId ? urlClientId : null) : storeClientId;

  const writeClientId = useCallback(
    (next: string | null, replace = false) =>
      void navigate({
        to: '/admin',
        replace,
        search: previous => ({
          ...previous,
          creditTab: 'side-apps',
          sideApp: next ?? undefined,
        }),
      }),
    [navigate]
  );

  // Arriving with a store selection and no link (View usage): put it in the URL once.
  useEffect(() => {
    if (!urlClientId && handedOverId) writeClientId(handedOverId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only; later URL changes must not be overwritten
  }, []);

  // Keep the store following the URL, including browser back removing the param.
  useEffect(() => {
    if (clientId && clientId === urlClientId) {
      urlSeen.current = true;
      setStoreClientId(clientId);
    } else if (!urlClientId && urlSeen.current) {
      urlSeen.current = false;
      setStoreClientId(null);
    }
  }, [clientId, urlClientId, setStoreClientId]);

  const selectClient = (next: string | null) => {
    setStoreClientId(next);
    writeClientId(next);
  };

  const users = useSideAppUsers(clientId, days);

  const chartData = useMemo(
    () => (data ? zeroFillDailySeries(data.totals.daily, data.spendWindowDays, d => d.credits) : []),
    [data]
  );
  const refusalLines = useMemo<RefusalLine[]>(() => {
    if (!data) return [];
    return [
      ...data.apps.flatMap(app =>
        app.refusals.byReason.map(entry => ({
          id: `${app.clientId}:${entry.reason}`,
          app: app.name,
          reason: entry.reason,
          refusalClass: entry.class,
          count: entry.count,
        }))
      ),
      ...data.unknownClient.byReason.map(entry => ({
        id: `unknown:${entry.reason}`,
        app: 'Unknown client',
        reason: entry.reason,
        refusalClass: entry.class,
        count: entry.count,
      })),
    ];
  }, [data]);

  const selected = data?.apps.find(app => app.clientId === clientId);

  return (
    <Stack gap={2} data-testid="side-apps-dashboard">
      <AdminPageHeader
        level="section"
        title="Side apps"
        description="Spend, traffic and refusals for apps connected through OAuth, split by who paid."
        actions={
          <Stack direction="row" gap={1}>
            <Button
              variant="plain"
              startDecorator={<DownloadIcon />}
              disabled={!data}
              onClick={() => {
                if (data) downloadSideAppsCsv(data);
                if (users.data) downloadSideAppUsersCsv(users.data);
              }}
              data-testid="side-apps-export-btn"
            >
              Export CSV
            </Button>
            <Button
              variant="plain"
              startDecorator={<RefreshIcon />}
              onClick={() => {
                void refetch();
                if (clientId) void users.refetch();
              }}
              disabled={isFetching}
              data-testid="side-apps-refresh-btn"
            >
              Refresh
            </Button>
          </Stack>
        }
      />
      <FilterBar
        search={false}
        state={{ query: '', view: '', filters: { days: String(days) } }}
        filters={[
          {
            id: 'days',
            label: 'Window',
            options: DAY_RANGES.map(value => ({ value: String(value), label: `${value} days` })),
          },
        ]}
        onChange={patch => {
          if (patch.filters) setDays(Number(patch.filters.days || 30));
        }}
      />

      {error ? (
        <ErrorState
          message={error instanceof Error ? error.message : 'Failed to load side apps'}
          onRetry={() => void refetch()}
        />
      ) : isLoading || !data ? (
        <LoadingState label="Loading side apps" testId="side-apps-loading" />
      ) : (
        <Stack spacing={3}>
          <Alert color="neutral" size="sm" data-testid="side-apps-note">
            Spend covers {data.spendWindowDays} days. Requests, outcomes and refusals cover at most 90 days (currently{' '}
            {data.requestWindowDays}). Payer tiers are recorded from {formatDate(data.attributionStartedAt)}; older
            spend within 90 days is attributed through its key; user-paid older spend is shown as unrecorded.
          </Alert>

          <StatStrip aria-label="Side apps key numbers">
            <StatTile label="Spend (credits)" value={formatCredits(data.totals.credits)} />
            <StatTile label="Active users" value={data.totals.activeUsers} />
            <StatTile
              label="Unpaid share of user-paid spend"
              value={formatPercent(data.totals.unpaidShare)}
              comparison={`${formatCredits(data.totals.byTier.unpaid)} of ${formatCredits(
                data.totals.byTier.paid + data.totals.byTier.unpaid
              )} credits`}
            />
            <StatTile
              label="Failure rate"
              value={formatPercent(data.totals.outcomes.failureRate)}
              comparison={`${data.totals.outcomes.failed + data.totals.outcomes.interrupted} of ${
                data.totals.outcomes.completed + data.totals.outcomes.failed + data.totals.outcomes.interrupted
              } finished`}
            />
          </StatStrip>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Credits over time
            </Typography>
            {data.totals.credits > 0 ? (
              <DailyAreaChart
                data={chartData}
                valueLabel="Credits"
                formatValue={formatCredits}
                color="primary"
                testid="side-apps-chart"
              />
            ) : (
              <Typography level="body-sm" color="neutral">
                No spend in this window.
              </Typography>
            )}
          </Box>

          <DataTable
            label="Side apps"
            testId="side-apps-table"
            rows={data.apps}
            getRowId={row => row.clientId}
            rowTestId={row => `side-apps-row-${row.clientId}`}
            activeRowId={clientId ?? undefined}
            onRowActivate={row => selectClient(row.clientId)}
            pagination={false}
            maxHeight="420px"
            onRetry={() => void refetch()}
            empty={<EmptyState title="No side app activity in this window" action={null} />}
            columns={[
              {
                id: 'app',
                label: 'App',
                render: row => (
                  <span title={row.clientId}>
                    {row.name}
                    <Typography level="body-xs" color="neutral">
                      {row.clientId}
                    </Typography>
                  </span>
                ),
              },
              { id: 'credits', label: 'Credits', numeric: true, render: row => formatCredits(row.spend.credits) },
              { id: 'users', label: 'Paying users', numeric: true, render: row => row.spend.payingUsers },
              { id: 'mix', label: 'Tier mix', render: row => <TierMix tiers={row.spend.byTier} /> },
              { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.total.toLocaleString() },
              {
                id: 'failure',
                label: 'Failure rate',
                numeric: true,
                render: row => (
                  <span
                    data-testid={`side-apps-failure-rate-${row.clientId}`}
                    title={row.topFailureCodes?.map(entry => `${entry.code}: ${entry.count}`).join('\n') || undefined}
                  >
                    {formatPercent(row.outcomes.failureRate)}
                  </span>
                ),
              },
              { id: 'refusals', label: 'Refusals', numeric: true, render: row => row.refusals.total.toLocaleString() },
            ]}
          />

          {clientId && (
            <Box data-testid="side-apps-drilldown">
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography level="title-sm">Users of {selected?.name ?? users.data?.name ?? clientId}</Typography>
                <Box sx={{ flex: 1 }} />
                <Button size="sm" variant="plain" onClick={() => selectClient(null)} data-testid="side-apps-close-btn">
                  Close
                </Button>
              </Stack>
              {users.error ? (
                <ErrorState
                  message={users.error instanceof Error ? users.error.message : 'Failed to load users'}
                  onRetry={() => void users.refetch()}
                />
              ) : users.isLoading || !users.data ? (
                <LoadingState label="Loading users" testId="side-apps-users-loading" />
              ) : (
                <Stack spacing={1}>
                  {users.data.totalUsers > users.data.limit && (
                    <Typography level="body-xs" color="neutral">
                      Showing the top {users.data.limit} of {users.data.totalUsers} users by credits.
                    </Typography>
                  )}
                  {users.data.unattributedOrgCredits > 0 && (
                    <Typography level="body-xs" color="neutral" data-testid="side-apps-unattributed-org">
                      {formatCredits(users.data.unattributedOrgCredits)} org-paid credits have no recorded member and
                      appear on no row.
                    </Typography>
                  )}
                  <UserTable rows={users.data.users} onRetry={() => void users.refetch()} />
                </Stack>
              )}
            </Box>
          )}

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Refusals
            </Typography>
            <DataTable
              label="Refusals"
              testId="side-apps-refusal-table"
              rows={refusalLines}
              getRowId={row => row.id}
              pagination={false}
              maxHeight="320px"
              onRetry={() => void refetch()}
              empty={<EmptyState title="No refusals in this window" action={null} />}
              columns={[
                { id: 'app', label: 'App', render: row => row.app },
                { id: 'class', label: 'Class', render: row => row.refusalClass },
                { id: 'reason', label: 'Reason', render: row => row.reason },
                { id: 'count', label: 'Count', numeric: true, render: row => row.count.toLocaleString() },
              ]}
            />
          </Box>
        </Stack>
      )}
    </Stack>
  );
};

export default SideAppsDashboard;
