import { Alert, Box, Button, Chip, CircularProgress, Sheet, Stack, Table, Tooltip, Typography } from '@mui/joy';
import {
  PlayArrowOutlined as PlayArrowOutlinedIcon,
  ShieldOutlined as ShieldOutlinedIcon,
  WarningAmberOutlined as WarningAmberOutlinedIcon,
} from '@mui/icons-material';
import { useAttackSimulationData, useRunAttackSimulation } from '@client/app/hooks/data/admin';
import { useSecurityScanCooldown } from '@client/app/hooks/useSecurityScanCooldown';
import type { ISecurityFindingDocument, ISecurityFindingRunDocument } from '@bike4mind/database';

const COOLDOWN_MS = 30 * 60 * 1000; // matches the server-side cooldown

const SEVERITY_COLOR: Record<string, 'danger' | 'warning' | 'neutral' | 'success'> = {
  P0: 'danger',
  P1: 'danger',
  P2: 'warning',
  P3: 'neutral',
};

const STATUS_COLOR: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  new: 'danger',
  persisting: 'warning',
  resolved: 'success',
  false_positive: 'neutral',
  running: 'warning',
  completed: 'success',
  failed: 'danger',
};

const formatDateTime = (value: Date | string | undefined): string => {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
};

const RunHistoryTable = ({ runs }: { runs: ISecurityFindingRunDocument[] }) => {
  if (runs.length === 0) {
    return (
      <Typography level="body-sm" sx={{ color: 'text.tertiary', py: 1 }}>
        No runs recorded yet.
      </Typography>
    );
  }
  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
      <Table data-testid="active-defense-run-history-table" size="sm">
        <thead>
          <tr>
            <th style={{ width: '20%' }}>Started</th>
            <th>Trigger</th>
            <th>Status</th>
            <th>New</th>
            <th>Persisting</th>
            <th>Resolved</th>
            <th>Probes</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          {runs.map(run => {
            const probeErrors = run.probeErrors ?? [];
            const errorCount = probeErrors.length + (run.error ? 1 : 0);
            return (
              <tr key={run.runId}>
                <td>{formatDateTime(run.startedAt)}</td>
                <td>{run.trigger}</td>
                <td>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={STATUS_COLOR[run.status] ?? 'neutral'}
                    data-testid={`active-defense-run-status-${run.runId}`}
                  >
                    {run.status}
                  </Chip>
                </td>
                <td>{run.findingCounts?.new ?? 0}</td>
                <td>{run.findingCounts?.persisting ?? 0}</td>
                <td>{run.findingCounts?.resolved ?? 0}</td>
                <td>
                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                    {(run.probesRun ?? []).length}
                  </Typography>
                </td>
                <td>
                  {errorCount === 0 ? (
                    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                      0
                    </Typography>
                  ) : (
                    <Tooltip
                      arrow
                      placement="left"
                      title={
                        <Stack spacing={0.5} sx={{ maxWidth: 400 }}>
                          {run.error ? (
                            <Typography level="body-xs" sx={{ color: 'common.white' }}>
                              run: {run.error}
                            </Typography>
                          ) : null}
                          {probeErrors.map((msg, idx) => (
                            <Typography key={idx} level="body-xs" sx={{ color: 'common.white' }}>
                              {msg}
                            </Typography>
                          ))}
                        </Stack>
                      }
                    >
                      <Chip
                        size="sm"
                        variant="soft"
                        color="warning"
                        data-testid={`active-defense-run-errors-${run.runId}`}
                      >
                        {errorCount}
                      </Chip>
                    </Tooltip>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Sheet>
  );
};

const FindingsList = ({ findings }: { findings: ISecurityFindingDocument[] }) => {
  if (findings.length === 0) {
    return (
      <Alert
        color="success"
        variant="soft"
        startDecorator={<ShieldOutlinedIcon />}
        data-testid="active-defense-no-findings"
      >
        No active findings — the deployment passed every probe in the most recent run.
      </Alert>
    );
  }
  return (
    <Stack spacing={1.5} data-testid="active-defense-findings-list">
      {findings.map(finding => (
        <Sheet
          key={finding.fingerprint}
          variant="outlined"
          sx={{ borderRadius: 'md', p: 2 }}
          data-testid={`active-defense-finding-${finding.fingerprint}`}
        >
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Chip size="sm" variant="soft" color={SEVERITY_COLOR[finding.severity] ?? 'neutral'}>
              {finding.severity}
            </Chip>
            <Chip size="sm" variant="soft" color={STATUS_COLOR[finding.status] ?? 'neutral'}>
              {finding.status}
            </Chip>
            <Typography level="title-sm">{finding.title}</Typography>
          </Stack>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 0.5 }}>
            {finding.endpoint} · {finding.category}
          </Typography>
          <Typography level="body-sm">{finding.details}</Typography>
          <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 1 }}>
            First seen {formatDateTime(finding.firstSeenAt)} · Last seen {formatDateTime(finding.lastSeenAt)}
            {finding.githubIssueUrl ? (
              <>
                {' · '}
                <a href={finding.githubIssueUrl} target="_blank" rel="noopener noreferrer">
                  GitHub issue #{finding.githubIssueNumber}
                </a>
              </>
            ) : null}
          </Typography>
        </Sheet>
      ))}
    </Stack>
  );
};

const ActiveDefenseTab = () => {
  const { data, isLoading, error } = useAttackSimulationData();
  const runMutation = useRunAttackSimulation();

  // Anchor the cooldown on the most recent terminal run's finishedAt (falls back to startedAt
  // for legacy records), not an in-flight run - a stuck `running` doc must not lock the button.
  // The 30-min window applies after completion; duplicate runs are blocked by the runner's single-flight guard.
  const latestTerminalRun = data?.runs?.find(r => r.status === 'completed' || r.status === 'failed');
  const cooldownAnchor = (latestTerminalRun?.finishedAt ?? latestTerminalRun?.startedAt) as Date | string | undefined;
  const cooldown = useSecurityScanCooldown(cooldownAnchor, COOLDOWN_MS);

  const latestRun = data?.runs?.[0];
  const lastRunLabel = latestRun ? formatDateTime(latestRun.startedAt) : 'never';
  const runDisabled = cooldown.cooldownActive || runMutation.isPending;
  const runInFlight = latestRun?.status === 'running';

  return (
    <Stack spacing={2.5} data-testid="active-defense-tab">
      <Stack direction="row" spacing={2} alignItems="flex-start" justifyContent="space-between">
        <Box>
          <Typography level="title-lg" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ShieldOutlinedIcon /> Active Defense
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 0.5 }}>
            Runs live attack probes against this deployment. Findings here represent issues reproducible in production
            traffic — not static analysis hits.
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.5 }}>
            Last run: {lastRunLabel}
            {cooldown.cooldownActive ? ` • Cooldown: ${cooldown.minutesRemaining} min remaining.` : ''}
            {runInFlight ? ' • A run is currently in flight.' : ''}
          </Typography>
        </Box>
        <Button
          startDecorator={<PlayArrowOutlinedIcon />}
          onClick={() => runMutation.mutate()}
          loading={runMutation.isPending}
          disabled={runDisabled}
          data-testid="active-defense-run-now-btn"
        >
          Run Now
        </Button>
      </Stack>

      {runMutation.isError && (
        <Alert
          color="danger"
          variant="soft"
          startDecorator={<WarningAmberOutlinedIcon />}
          data-testid="active-defense-run-error"
        >
          {runMutation.error instanceof Error ? runMutation.error.message : 'Failed to start attack simulation.'}
        </Alert>
      )}

      {runMutation.isSuccess && runMutation.data?.queued && (
        <Alert color="success" variant="soft" data-testid="active-defense-run-queued">
          Attack simulation queued (run {runMutation.data.runId}). Results will appear here when the run completes.
        </Alert>
      )}

      {error && (
        <Alert color="danger" variant="soft" data-testid="active-defense-load-error">
          Failed to load attack simulation data.
        </Alert>
      )}

      {isLoading ? (
        <Stack alignItems="center" sx={{ py: 4 }}>
          <CircularProgress size="md" />
        </Stack>
      ) : (
        <Stack spacing={3}>
          <Box>
            <Typography level="title-md" sx={{ mb: 1 }}>
              Active findings ({data?.findings?.length ?? 0})
            </Typography>
            <FindingsList findings={data?.findings ?? []} />
          </Box>
          <Box>
            <Typography level="title-md" sx={{ mb: 1 }}>
              Run history
            </Typography>
            <RunHistoryTable runs={data?.runs ?? []} />
          </Box>
        </Stack>
      )}
    </Stack>
  );
};

export default ActiveDefenseTab;
