import React, { useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Sheet,
  Stack,
  Table,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { UNCLASSIFIED_SOURCE } from '@bike4mind/common';
import { useSearchOrganizations } from '@client/app/hooks/data/organizations';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { formatCredits, formatUsd, numberCell } from '../utils/format';
import { useOrgUsage } from '../hooks/useOrgUsage';

const DAY_RANGES = [30, 60, 90] as const;
type DayRange = (typeof DAY_RANGES)[number];

type OrgOption = { id: string; name: string };

/**
 * Zero-fill every day in the window so the burn chart draws gaps as flat rather
 * than connecting non-adjacent active days into a misleading straight line.
 * Days are UTC to match the aggregation's $dateToString bucketing.
 */
const buildBurnSeries = (overTime: { day: string; creditsCharged: number }[], days: number) => {
  const byDay = new Map(overTime.map(d => [d.day, d.creditsCharged]));
  const today = new Date();
  // days + 1 points spanning today-days .. today (UTC). The aggregation's window
  // start is a rolling `now - days*24h`, whose calendar day is `today - days`;
  // include that leading day or its (partial) spend drops off the chart while
  // still counting in the totals, leaving the bars unable to reconcile.
  return Array.from({ length: days + 1 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (days - i));
    const day = d.toISOString().slice(0, 10);
    return { day, credits: byDay.get(day) ?? 0 };
  });
};

/**
 * Per-organization AI spend: a credits burn chart over the selected window plus
 * member / model / feature / API key / source breakdowns. Scoped to spend billed
 * to the org's credit pool (ownerType=Organization). See /api/admin/org-usage.
 */
export const OrgUsageDashboard: React.FC = () => {
  const theme = useTheme();
  const [selectedOrg, setSelectedOrg] = useState<OrgOption | null>(null);
  const [days, setDays] = useState<DayRange>(30);

  // Debounce so typing a name fires one request per pause, not one per keystroke.
  const { debouncedValue: orgSearch, setValue: setOrgSearch } = useDebounceValue('', 500);

  // Team orgs only: personal orgs are single-user and not the point of an org dashboard.
  const { data: orgResult, isLoading: orgsLoading } = useSearchOrganizations({
    page: 1,
    limit: 20,
    search: orgSearch,
    filters: { personal: false },
    orderBy: { by: 'name', direction: 'asc' },
  });

  const orgOptions: OrgOption[] = useMemo(
    () => (orgResult?.data ?? []).map(o => ({ id: String(o.id), name: o.name })),
    [orgResult]
  );

  const { data, isLoading, isFetching, error, refetch } = useOrgUsage(selectedOrg?.id ?? null, days);

  const hasUsage = (data?.totals.requests ?? 0) > 0;
  const chartData = useMemo(() => buildBurnSeries(data?.overTime ?? [], days), [data, days]);

  return (
    <Box sx={{ p: { xs: 1, sm: 2 } }} data-testid="org-usage-dashboard">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
        spacing={1}
        sx={{ mb: 1 }}
      >
        <Autocomplete
          placeholder="Select an organization"
          options={orgOptions}
          getOptionLabel={o => o.name}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          value={selectedOrg}
          onChange={(_, value) => setSelectedOrg(value)}
          onInputChange={(_, value) => setOrgSearch(value)}
          loading={orgsLoading}
          sx={{ minWidth: 260 }}
          data-testid="org-usage-org-select"
        />
        <Stack direction="row" spacing={1} alignItems="center">
          <ToggleButtonGroup
            size="sm"
            value={String(days)}
            onChange={(_, value) => value && setDays(Number(value) as DayRange)}
            data-testid="org-usage-range-toggle"
          >
            {DAY_RANGES.map(r => (
              <Button key={r} value={String(r)}>
                {r}d
              </Button>
            ))}
          </ToggleButtonGroup>
          <IconButton
            size="sm"
            onClick={() => refetch()}
            disabled={!selectedOrg || isFetching}
            data-testid="org-usage-refresh-btn"
          >
            <RefreshIcon />
          </IconButton>
        </Stack>
      </Stack>

      <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
        Spend billed to this organization&apos;s credit pool (owner-scoped). Members are the users who ran each call;
        feature is the product surface (chat, agent, operations, embedding). Data comes from usage events recorded since
        deploy.
      </Alert>

      {error && (
        <Alert color="danger" sx={{ mb: 2 }} data-testid="org-usage-error">
          {(error as Error)?.message || 'Failed to load organization usage'}
        </Alert>
      )}

      {!selectedOrg ? (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography level="body-sm" color="neutral">
            Select an organization to see its spend.
          </Typography>
        </Box>
      ) : isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Stack spacing={3}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip color="primary" variant="soft" data-testid="org-usage-total-credits">
              {formatCredits(data?.totals.creditsCharged ?? 0)} credits
            </Chip>
            <Chip color="neutral" variant="soft" data-testid="org-usage-total-cogs">
              {formatUsd(data?.totals.cogsUsd ?? 0)} COGS
            </Chip>
            <Chip color="neutral" variant="soft" data-testid="org-usage-total-requests">
              {(data?.totals.requests ?? 0).toLocaleString()} requests
            </Chip>
          </Stack>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Credits over time
            </Typography>
            {!hasUsage ? (
              <Typography level="body-sm" color="neutral">
                No usage in this window.
              </Typography>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} width={56} />
                  <Tooltip
                    formatter={value => [formatCredits(Number(value) || 0), 'Credits']}
                    contentStyle={{
                      background: theme.palette.background.surface,
                      border: `1px solid ${theme.palette.divider}`,
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="credits"
                    stroke={theme.palette.primary[500]}
                    fill={theme.palette.primary.softBg}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Box>

          <BreakdownTable
            title="By member"
            testid="org-usage-member-table"
            keyLabel="Member"
            rows={(data?.byMember ?? []).map(r => ({
              key: r.userId,
              label: r.userName ?? 'Unknown user',
              title: r.userId,
              requests: r.requests,
              cogsUsd: r.cogsUsd,
              creditsCharged: r.creditsCharged,
            }))}
          />

          <BreakdownTable
            title="By model"
            testid="org-usage-model-table"
            keyLabel="Model"
            rows={(data?.byModel ?? []).map(r => ({
              key: `${r.provider}-${r.model}`,
              label: `${r.provider} / ${r.model}`,
              requests: r.requests,
              cogsUsd: r.cogsUsd,
              creditsCharged: r.creditsCharged,
            }))}
          />

          <BreakdownTable
            title="By feature"
            testid="org-usage-feature-table"
            keyLabel="Feature"
            rows={(data?.byFeature ?? []).map(r => ({
              key: r.feature,
              label: r.feature,
              requests: r.requests,
              cogsUsd: r.cogsUsd,
              creditsCharged: r.creditsCharged,
            }))}
          />

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              By API key
            </Typography>
            <Typography level="body-xs" color="neutral" sx={{ mb: 1 }}>
              API-token spend billed to this org (from the ledger; no COGS on API-key rows).
            </Typography>
            <Sheet sx={{ maxHeight: 320, overflow: 'auto' }}>
              <Table stickyHeader hoverRow size="sm" data-testid="org-usage-apikey-table">
                <thead>
                  <tr>
                    <th>API key</th>
                    <th style={{ textAlign: 'right' }}>Requests</th>
                    <th style={{ textAlign: 'right' }}>Input tokens</th>
                    <th style={{ textAlign: 'right' }}>Output tokens</th>
                    <th style={{ textAlign: 'right' }}>Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.byApiKey ?? []).map(k => (
                    <tr key={k.apiKeyId}>
                      <td title={k.keyPrefix ?? k.apiKeyId}>{k.keyName ?? 'Unknown key'}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{k.requests.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{k.inputTokens.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{k.outputTokens.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{formatCredits(k.creditsSpent)}</td>
                    </tr>
                  ))}
                  {(data?.byApiKey ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <Typography level="body-sm" color="neutral">
                          No API-token usage in this window.
                        </Typography>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Sheet>
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              By source
            </Typography>
            <Typography level="body-xs" color="neutral" sx={{ mb: 1 }}>
              Where this org&apos;s spend originated (from the ledger; credits only, no COGS). &quot;Unclassified&quot;
              is usage with no source recorded on the ledger row.
            </Typography>
            <Sheet sx={{ maxHeight: 320, overflow: 'auto' }}>
              <Table stickyHeader hoverRow size="sm" data-testid="org-usage-source-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th style={{ textAlign: 'right' }}>Requests</th>
                    <th style={{ textAlign: 'right' }}>Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.bySource ?? []).map(s => (
                    <tr key={s.source}>
                      <td>{s.source === UNCLASSIFIED_SOURCE ? 'Unclassified' : s.source}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{s.requests.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{formatCredits(s.creditsSpent)}</td>
                    </tr>
                  ))}
                  {(data?.bySource ?? []).length === 0 && (
                    <tr>
                      <td colSpan={3}>
                        <Typography level="body-sm" color="neutral">
                          No usage in this window.
                        </Typography>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Sheet>
          </Box>
        </Stack>
      )}
    </Box>
  );
};

type BreakdownRow = {
  key: string;
  label: string;
  title?: string;
  requests: number;
  cogsUsd: number;
  creditsCharged: number;
};

const BreakdownTable: React.FC<{
  title: string;
  keyLabel: string;
  testid: string;
  rows: BreakdownRow[];
}> = ({ title, keyLabel, testid, rows }) => (
  <Box>
    <Typography level="title-sm" sx={{ mb: 1 }}>
      {title}
    </Typography>
    <Sheet sx={{ maxHeight: 320, overflow: 'auto' }}>
      <Table stickyHeader hoverRow size="sm" data-testid={testid}>
        <thead>
          <tr>
            <th>{keyLabel}</th>
            <th style={{ textAlign: 'right' }}>Requests</th>
            <th style={{ textAlign: 'right' }}>COGS (USD)</th>
            <th style={{ textAlign: 'right' }}>Credits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              <td title={row.title}>{row.label}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{row.requests.toLocaleString()}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{formatUsd(row.cogsUsd)}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{formatCredits(row.creditsCharged)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4}>
                <Typography level="body-sm" color="neutral">
                  No usage in this window.
                </Typography>
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </Sheet>
  </Box>
);
