import { useCloudScanRequest } from './CloudScanRequest';
import { useEffect, useState } from 'react';
import { Box, IconButton, Skeleton, Stack, Tooltip, Typography } from '@mui/joy';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import { toast } from 'sonner';
import {
  useAttackSimulationData,
  useRunAttackSimulation,
  useRunWebSecurityScan,
  useSecopsTriageStatus,
  useSecurityDashboardOverview,
  useSecurityDashboardProwler,
  useSecurityScanSchedules,
  type SecurityCheckStatus,
  type SecurityCheckSummary,
} from '@client/app/hooks/data/admin';
import { useSecurityScanCooldown, type SecurityScanCooldown } from '@client/app/hooks/useSecurityScanCooldown';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { AdminPermissionAction, DataTable, formatUtc, RelativeTime, StatusChip, UpdatingBar } from '../shared';
import type { SecurityScan } from '../securityDashboardSearch';
import { ACTIVE_DEFENSE_COOLDOWN_MS } from './ActiveDefenseTab';
import { describeIssueOutcome, latestFilingRun } from './issueFiling';
import { useProwlerScanRequest } from './ProwlerScanRequest';

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
  /** The schedules have not arrived yet, so the next run is not known. */
  nextRunLoading?: boolean;
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

/** A scan an admin can start from its row. */
type ScanRunner = {
  /** The row button's accessible name, e.g. "Run website scan". */
  label: string;
  pending: boolean;
  /** Why the scan cannot start right now, shown on the disabled button; null when it can. */
  blockedReason: string | null;
  start: () => void;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function blockedReason(cooldown: SecurityScanCooldown, lastRunUnknown: boolean): string | null {
  if (lastRunUnknown) return 'Available once the last run has loaded';
  if (!cooldown.cooldownActive) return null;
  return cooldown.remainingMs >= HOUR_MS
    ? `Available again in ${plural(cooldown.hoursRemaining, 'hour')}`
    : `Available again in ${plural(cooldown.minutesRemaining, 'minute')}`;
}

const errorText = (error: unknown): string => {
  const body = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  if (typeof body === 'string' && body) return body;
  return error instanceof Error ? error.message : 'Unknown error';
};

const stopRowClick = (event: { stopPropagation: () => void }) => event.stopPropagation();

function RunScanButton({ scan, runner }: { scan: SecurityScan; runner: ScanRunner }) {
  return (
    // Keeps a click on the button, or on the wrapper of a disabled one, from also opening the row's panel.
    <Box component="span" onClick={stopRowClick} onKeyDown={stopRowClick} sx={{ display: 'inline-flex' }}>
      <AdminPermissionAction requirement="settings:manage" blockedReason={runner.blockedReason}>
        {disabled => (
          <Tooltip title={disabled ? undefined : runner.label}>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label={runner.label}
              disabled={disabled || runner.pending}
              loading={runner.pending}
              onClick={runner.start}
              data-testid={`security-scans-summary-${scan}-run-btn`}
            >
              <PlayArrowOutlinedIcon />
            </IconButton>
          </Tooltip>
        )}
      </AdminPermissionAction>
    </Box>
  );
}

function IssuesCell({ scan, status }: { scan: SecurityScan; status: ReturnType<typeof useSecopsTriageStatus> }) {
  const testId = `security-scans-summary-${scan}-issues`;
  if (!status.data) {
    if (!status.isError) return <Skeleton variant="text" level="body-sm" width="10ch" />;
    return (
      <Box component="span" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
        Unavailable
      </Box>
    );
  }
  const run = latestFilingRun(status.data.latestRunPerSource ?? [], scan);
  if (!run) {
    return (
      <Box component="span" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
        {DASH}
      </Box>
    );
  }
  // The filing run is dated because it can be older than the scan's last run: a scan with nothing
  // at or above the threshold sends no findings, so it records no run of its own.
  return (
    <Box component="span" data-testid={testId}>
      {describeIssueOutcome(run)},{' '}
      <Box component="span" sx={{ color: 'admin.inkMuted' }}>
        <RelativeTime at={run.startedAt} />
      </Box>
    </Box>
  );
}

function checkRow(
  id: 'web' | 'cloud',
  label: string,
  check: SecurityCheckSummary | undefined,
  overview: { loading: boolean; failed: boolean },
  nextRunAt: string | null,
  nextRunUnavailable: boolean,
  nextRunLoading: boolean
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
    nextRunLoading,
  };
}

/**
 * One row per scan type with its latest result and the outcome of its latest issue filing run.
 * Selecting a row opens that scan's panel below; the row's Run action starts the scan with the same
 * request and cooldown as the panel's own button. The weekly schedules stay in the panels.
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
  const filing = useSecopsTriageStatus();
  const runWeb = useRunWebSecurityScan();
  const runCloud = useCloudScanRequest();
  const runProwler = useProwlerScanRequest();
  const runProbes = useRunAttackSimulation();

  const overviewState = { loading: !overview.data && !overview.isError, failed: !overview.data && overview.isError };
  const checks = overview.data?.checks ?? [];
  const schedulesFailed = !schedules.data && schedules.isError;
  const schedulesLoading = !schedules.data && !schedules.isError;
  const scheduled = (key: 'web' | 'cloud') => {
    const schedule = schedules.data?.[key];
    return schedule?.enabled && schedule.nextRunAt ? schedule.nextRunAt : null;
  };

  const prowlerSnapshot = prowler.data;
  const latestRun = attack.data?.runs?.[0];
  const latestTerminalRun = attack.data?.runs?.find(run => run.status === 'completed' || run.status === 'failed');

  const webCheck = checks.find(check => check.id === 'web');
  const cloudCheck = checks.find(check => check.id === 'cloud');
  const webCooldown = useSecurityScanCooldown(webCheck?.lastCheckedAt);
  const cloudCooldown = runCloud.cooldown;
  const prowlerCooldown = useSecurityScanCooldown(prowlerSnapshot?.checkedAt);
  const probesCooldown = useSecurityScanCooldown(
    latestTerminalRun?.finishedAt ?? latestTerminalRun?.startedAt,
    ACTIVE_DEFENSE_COOLDOWN_MS
  );

  const notStarted = (what: string) => (error: unknown) =>
    toast.error(`${what} could not be started: ${errorText(error)}`);
  const runners: Record<SecurityScan, ScanRunner> = {
    web: {
      label: 'Run website scan',
      pending: runWeb.isPending,
      blockedReason: blockedReason(webCooldown, !overview.data),
      start: () =>
        runWeb.mutate(undefined, {
          onSuccess: () => toast.success('Website scan queued. Results appear here when it finishes.'),
          onError: notStarted('Website scan'),
        }),
    },
    cloud: {
      label: runCloud.queued ? 'Cloud baseline scan queued' : 'Run cloud baseline scan',
      pending: runCloud.pending,
      blockedReason: runCloud.queued
        ? 'Cloud baseline scan queued; awaiting a new scan result'
        : blockedReason(cloudCooldown, !overview.data || runCloud.loading),
      start: runCloud.start,
    },
    prowler: {
      label: runProwler.queued ? 'Prowler scan queued' : 'Run Prowler scan',
      pending: runProwler.pending,
      blockedReason: runProwler.queued
        ? 'Prowler scan queued; awaiting a new audit result'
        : blockedReason(prowlerCooldown, prowler.data === undefined),
      start: runProwler.start,
    },
    'active-defense': {
      label: 'Run active defense probes',
      pending: runProbes.isPending,
      blockedReason: blockedReason(probesCooldown, !attack.data),
      start: () =>
        runProbes.mutate(undefined, {
          onSuccess: () => toast.success('Active defense probes started.'),
          onError: notStarted('Active defense probes'),
        }),
    },
  };
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
    checkRow('web', 'Website', webCheck, overviewState, scheduled('web'), schedulesFailed, schedulesLoading),
    checkRow(
      'cloud',
      'Cloud baseline',
      cloudCheck,
      overviewState,
      scheduled('cloud'),
      schedulesFailed,
      schedulesLoading
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

  const allLoaded = !schedulesLoading && rows.every(row => !row.loading);
  const refreshing = [overview, schedules, prowler, attack, filing].some(
    query => query.isFetching && Boolean(query.data)
  );

  return (
    <Stack gap={1}>
      <UpdatingBar active={allLoaded && refreshing} testId="security-scans-summary-updating" />
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
          void filing.refetch();
        }}
        pagination={false}
        minWidth="52rem"
        maxHeight="none"
        rowActions={row => <RunScanButton scan={row.id} runner={runners[row.id]} />}
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
            id: 'issues',
            label: 'Issues',
            width: '14rem',
            render: row => <IssuesCell scan={row.id} status={filing} />,
          },
          {
            id: 'next-run',
            label: 'Next run',
            render: row =>
              row.loading || row.nextRunLoading ? (
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
