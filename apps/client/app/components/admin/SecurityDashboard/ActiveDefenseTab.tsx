import { Alert, Box, Button, Stack, Typography } from '@mui/joy';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import { useAttackSimulationData, useRunAttackSimulation } from '@client/app/hooks/data/admin';
import { useSecurityScanCooldown } from '@client/app/hooks/useSecurityScanCooldown';
import { AdminPageHeader, DataTable, ErrorState, SectionCard, StatusChip } from '../shared';
import { SecurityFindingsTable } from './SecurityFindingsTable';

const COOLDOWN_MS = 30 * 60 * 1000;
const formatDateTime = (value: Date | string | undefined) => {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toUTCString();
};

const ActiveDefenseTab = () => {
  const { data, isLoading, error, refetch } = useAttackSimulationData();
  const runMutation = useRunAttackSimulation();
  const latestTerminalRun = data?.runs?.find(run => run.status === 'completed' || run.status === 'failed');
  const cooldown = useSecurityScanCooldown(latestTerminalRun?.finishedAt ?? latestTerminalRun?.startedAt, COOLDOWN_MS);
  const latestRun = data?.runs?.[0];
  const runs = data?.runs ?? [];
  const findings = (data?.findings ?? []).map(finding => ({
    ...finding,
    id: finding.fingerprint,
    description: finding.details,
  }));

  return (
    <Stack spacing={2} data-testid="active-defense-tab">
      <AdminPageHeader
        title="Active defense"
        description="Run live probes and review reproducible findings."
        actions={
          <Button
            startDecorator={<PlayArrowOutlinedIcon />}
            onClick={() => runMutation.mutate()}
            loading={runMutation.isPending}
            disabled={cooldown.cooldownActive || runMutation.isPending}
            data-testid="active-defense-run-now-btn"
          >
            Run probes
          </Button>
        }
      />
      <Typography level="body-sm">
        Last run: {formatDateTime(latestRun?.startedAt)}
        {cooldown.cooldownActive ? ` - Cooldown: ${cooldown.minutesRemaining} min remaining.` : ''}
        {latestRun?.status === 'running' ? ' - A run is currently in flight.' : ''}
      </Typography>
      {runMutation.isError && (
        <Alert color="danger" data-testid="active-defense-run-error">
          {runMutation.error instanceof Error ? runMutation.error.message : 'Failed to start attack simulation.'}
        </Alert>
      )}
      {runMutation.isSuccess && runMutation.data?.queued && (
        <Alert color="success" data-testid="active-defense-run-queued">
          Attack simulation queued (run {runMutation.data.runId}). Results appear when the run completes.
        </Alert>
      )}
      {error ? (
        <Box data-testid="active-defense-load-error">
          <ErrorState message="Failed to load attack simulation data." onRetry={() => void refetch()} />
        </Box>
      ) : (
        <>
          <SectionCard title={`Active findings (${findings.length})`}>
            {isLoading ? (
              <DataTable
                rows={[]}
                columns={[{ id: 'title', label: 'Finding', render: () => '' }]}
                getRowId={() => ''}
                label="Loading findings"
                loading
                onRetry={() => void refetch()}
              />
            ) : (
              <SecurityFindingsTable
                rows={findings}
                testId="active-defense"
                onRetry={() => void refetch()}
                renderDetail={finding => (
                  <Stack spacing={1}>
                    <Typography>
                      {finding.endpoint} - {finding.category}
                    </Typography>
                    <StatusChip
                      tone={
                        finding.status === 'resolved'
                          ? 'good'
                          : finding.status === 'false_positive'
                            ? 'neutral'
                            : 'warn'
                      }
                      label={finding.status}
                    />
                    <Typography>First seen: {formatDateTime(finding.firstSeenAt)}</Typography>
                    <Typography>Last seen: {formatDateTime(finding.lastSeenAt)}</Typography>
                    {finding.githubIssueUrl?.startsWith('https://') && (
                      <Button
                        component="a"
                        href={finding.githubIssueUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="plain"
                        data-testid="active-defense-issue-link"
                      >
                        View tracking issue
                      </Button>
                    )}
                  </Stack>
                )}
              />
            )}
          </SectionCard>
          <SectionCard title="Run history">
            <DataTable
              rows={runs}
              loading={isLoading}
              getRowId={run => run.runId}
              label="Probe run history"
              testId="active-defense-run-history-table"
              onRetry={() => void refetch()}
              columns={[
                { id: 'started', label: 'Started', render: run => formatDateTime(run.startedAt) },
                { id: 'trigger', label: 'Trigger', render: run => run.trigger },
                {
                  id: 'status',
                  label: 'Status',
                  render: run => (
                    <StatusChip
                      tone={run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}
                      label={run.status}
                    />
                  ),
                },
                { id: 'new', label: 'New', numeric: true, render: run => run.findingCounts?.new ?? 0 },
                {
                  id: 'persisting',
                  label: 'Persisting',
                  numeric: true,
                  render: run => run.findingCounts?.persisting ?? 0,
                },
                { id: 'resolved', label: 'Resolved', numeric: true, render: run => run.findingCounts?.resolved ?? 0 },
                { id: 'probes', label: 'Probes', numeric: true, render: run => run.probesRun?.length ?? 0 },
                {
                  id: 'errors',
                  label: 'Errors',
                  render: run => (
                    <Typography sx={{ overflowWrap: 'anywhere' }}>
                      {[run.error, ...(run.probeErrors ?? [])].filter(Boolean).join('; ') || '0'}
                    </Typography>
                  ),
                },
              ]}
            />
          </SectionCard>
        </>
      )}
    </Stack>
  );
};

export default ActiveDefenseTab;
