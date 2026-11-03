import { useEffect, useState } from 'react';
import { Box, Skeleton, Stack, Tooltip, Typography } from '@mui/joy';
import {
  useAttackSimulationData,
  useSecurityDashboardOverview,
  useSecurityDashboardProwler,
  useSecurityScanSchedules,
  type SecurityCheckStatus,
  type SecurityCheckSummary,
} from '@client/app/hooks/data/admin';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { DataTable, formatUtc, RelativeTime, StatusChip, UpdatingBar } from '../shared';
import type { SecurityScan } from '../securityDashboardSearch';

const DASH = '\u2014';

type Severity = 'critical' | 'high' | 'medium' | 'low';
const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

type ScanStatus = { tone: AdminStatusTone; label: string };

type ScanSummaryRow = {
  id: SecurityScan;
  label: string;
  loading: boolean;
  status: ScanStatus;
  lastRunAt: string | null;
  findings: string | null;
  /** null: no schedule, so the scan only runs when started by hand. */
  nextRunAt: string | null;
  /** The schedules failed to load, so a missing next run does not mean manual. */
  nextRunUnavailable?: boolean;
};

const CHECK_STATUS: Record<SecurityCheckStatus, ScanStatus> = {
  pass: { tone: 'good', label: 'Passed' },
  warning: { tone: 'warn', label: 'Review' },
  fail: { tone: 'bad', label: 'Issues found' },
  disabled: { tone: 'neutral', label: 'Disabled' },
};
const NOT_RUN: ScanStatus = { tone: 'neutral', label: 'Not run' };
const UNAVAILABLE: ScanStatus = { tone: 'neutral', label: 'Unavailable' };

/** "2 high, 5 medium"; "None" when every count is zero. */
export function compactSeverityCounts(counts: Partial<Record<string, number>>, order: readonly string[]): string {
  const parts = order.filter(level => (counts[level] ?? 0) > 0).map(level => `${counts[level]} ${level}`);
  return parts.length > 0 ? parts.join(', ') : 'None';
}

const countSeverities = <T extends string>(items: ReadonlyArray<{ severity: T }>) =>
  items.reduce<Partial<Record<T, number>>>((counts, item) => {
    counts[item.severity] = (counts[item.severity] ?? 0) + 1;
    return counts;
  }, {});

/** "in 3 days" for a time ahead; a time already passed reads as pending. */
function untilLabel(date: Date, now: number): string {
  const seconds = Math.round((date.getTime() - now) / 1000);
  if (seconds <= 0) return 'Pending';
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (seconds < 3600) return formatter.format(Math.max(1, Math.round(seconds / 60)), 'minute');
  if (seconds < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86400), 'day');
}

function NextRun({ at, unavailable, testId }: { at: string | null; unavailable?: boolean; testId: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const date = at ? new Date(at) : undefined;
  if (unavailable) {
    return (
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
        Unavailable
      </Typography>
    );
  }
  if (!date || Number.isNaN(date.getTime())) {
    return (
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
        Manual
      </Typography>
    );
  }
  return (
    <Tooltip title={formatUtc(date)}>
      <Typography
        component="time"
        dateTime={date.toISOString()}
        tabIndex={0}
        level="body-sm"
        sx={{ color: 'admin.inkMuted' }}
        data-testid={testId}
      >
        {untilLabel(date, now)}
      </Typography>
    </Tooltip>
  );
}

function checkRow(
  id: 'web' | 'cloud',
  label: string,
  check: SecurityCheckSummary | undefined,
  overview: { loading: boolean; failed: boolean },
  nextRunAt: string | null,
  nextRunUnavailable: boolean
): ScanSummaryRow {
  return {
    id,
    label,
    loading: overview.loading,
    status: overview.failed ? UNAVAILABLE : !check?.lastCheckedAt ? NOT_RUN : CHECK_STATUS[check.status],
    lastRunAt: check?.lastCheckedAt ?? null,
    findings: check?.lastCheckedAt ? compactSeverityCounts(check.severityCounts, SEVERITIES) : null,
    nextRunAt,
    nextRunUnavailable,
  };
}

/**
 * One row per scan type with its latest result. Selecting a row opens that scan's panel below;
 * starting scans and the weekly schedules stay in those panels.
 */
export function ScanSummaryTable({
  activeScan,
  onSelect,
}: {
  activeScan: SecurityScan;
  onSelect: (scan: SecurityScan) => void;
}) {
  const overview = useSecurityDashboardOverview();
  const schedules = useSecurityScanSchedules();
  const prowler = useSecurityDashboardProwler();
  const attack = useAttackSimulationData();

  const overviewState = { loading: !overview.data && !overview.isError, failed: !overview.data && overview.isError };
  const checks = overview.data?.checks ?? [];
  const schedulesFailed = !schedules.data && schedules.isError;
  const scheduled = (key: 'web' | 'cloud') => {
    const schedule = schedules.data?.[key];
    return schedule?.enabled && schedule.nextRunAt ? schedule.nextRunAt : null;
  };

  const prowlerSnapshot = prowler.data;
  const latestRun = attack.data?.runs?.[0];
  const openFindings = (attack.data?.findings ?? []).filter(
    finding => finding.status === 'new' || finding.status === 'persisting'
  );
  const activeDefenseStatus = (): ScanStatus => {
    if (!attack.data && attack.isError) return UNAVAILABLE;
    if (!latestRun) return NOT_RUN;
    if (latestRun.status === 'running') return { tone: 'info', label: 'Running' };
    if (latestRun.status === 'failed') return { tone: 'bad', label: 'Run failed' };
    return openFindings.length > 0 ? { tone: 'warn', label: 'Findings open' } : { tone: 'good', label: 'Passed' };
  };

  const rows: ScanSummaryRow[] = [
    checkRow(
      'web',
      'Website',
      checks.find(check => check.id === 'web'),
      overviewState,
      scheduled('web'),
      schedulesFailed
    ),
    checkRow(
      'cloud',
      'Cloud baseline',
      checks.find(check => check.id === 'cloud'),
      overviewState,
      scheduled('cloud'),
      schedulesFailed
    ),
    {
      id: 'prowler',
      label: 'Prowler',
      loading: !prowlerSnapshot && prowler.isLoading,
      status: prowlerSnapshot ? CHECK_STATUS[prowlerSnapshot.status] : prowler.isError ? UNAVAILABLE : NOT_RUN,
      lastRunAt: prowlerSnapshot?.checkedAt ?? null,
      findings: prowlerSnapshot
        ? compactSeverityCounts(countSeverities(prowlerSnapshot.findings ?? []), SEVERITIES)
        : null,
      nextRunAt: null,
    },
    {
      id: 'active-defense',
      label: 'Active defense',
      loading: !attack.data && attack.isLoading,
      status: activeDefenseStatus(),
      lastRunAt: latestRun ? String(latestRun.startedAt) : null,
      findings: latestRun ? compactSeverityCounts(countSeverities(openFindings), ['P0', 'P1', 'P2', 'P3']) : null,
      nextRunAt: null,
    },
  ];

  const allLoaded = rows.every(row => !row.loading);
  const refreshing = overview.isFetching || schedules.isFetching || prowler.isFetching || attack.isFetching;

  return (
    <Stack gap={1}>
      {allLoaded && refreshing && <UpdatingBar testId="security-scans-summary-updating" />}
      <DataTable
        label="Scans"
        testId="security-scans-summary-table"
        rows={rows}
        getRowId={row => row.id}
        rowTestId={row => `security-scans-summary-${row.id}-row`}
        activeRowId={activeScan}
        onRowActivate={row => onSelect(row.id)}
        onRetry={() => {
          void overview.refetch();
          void schedules.refetch();
          void prowler.refetch();
          void attack.refetch();
        }}
        pagination={false}
        minWidth="36rem"
        maxHeight="none"
        columns={[
          { id: 'scan', label: 'Scan', render: row => row.label },
          {
            id: 'status',
            label: 'Status',
            render: row =>
              row.loading ? (
                <Skeleton variant="text" level="body-sm" width="8ch" />
              ) : (
                <StatusChip
                  tone={row.status.tone}
                  label={row.status.label}
                  data-testid={`security-scans-summary-${row.id}-status`}
                />
              ),
          },
          {
            id: 'last-run',
            label: 'Last run',
            render: row =>
              row.loading ? (
                <Skeleton variant="text" level="body-sm" width="10ch" />
              ) : row.lastRunAt ? (
                <RelativeTime at={row.lastRunAt} />
              ) : (
                <Box component="span" sx={{ color: 'admin.inkMuted' }}>
                  {DASH}
                </Box>
              ),
          },
          {
            id: 'findings',
            label: 'Findings',
            render: row =>
              row.loading ? (
                <Skeleton variant="text" level="body-sm" width="12ch" />
              ) : (
                <Box
                  component="span"
                  sx={{ color: row.findings ? 'admin.ink' : 'admin.inkMuted' }}
                  data-testid={`security-scans-summary-${row.id}-findings`}
                >
                  {row.findings ?? DASH}
                </Box>
              ),
          },
          {
            id: 'next-run',
            label: 'Next run',
            render: row =>
              row.loading ? (
                <Skeleton variant="text" level="body-sm" width="8ch" />
              ) : (
                <NextRun
                  at={row.nextRunAt}
                  unavailable={row.nextRunUnavailable}
                  testId={`security-scans-summary-${row.id}-next`}
                />
              ),
          },
        ]}
      />
    </Stack>
  );
}
