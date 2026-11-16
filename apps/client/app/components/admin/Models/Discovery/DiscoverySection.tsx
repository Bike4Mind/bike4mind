import { Alert, Box, Button, Link, Skeleton, Stack, Typography } from '@mui/joy';
import { DataTable, EmptyState, ErrorState, StatusChip, UpdatingBar, type DataColumn } from '../../shared';
import { ADMIN_REGION_GAP } from '../../shared/adminStyles';
import { ModelWriteAction } from '../ModelWriteAction';
import { useModelsNavigation } from '../modelsNavigation';
import { apiErrorMessage, useDiscoveryStatus, type DiscoveryRunListItem, type DiscoveryStatus } from './discoveryApi';
import {
  DISCOVERY_OFF_DESCRIPTION,
  DISCOVERY_OFF_TITLE,
  RUN_RETENTION_NOTE,
  formatClock,
  formatRunTime,
  lastRunCopy,
  modeLabel,
  nextScheduledRun,
  policyLabel,
  runChangeSummary,
  runResult,
  sourceSkipCopy,
  triggerLabel,
} from './discoveryCopy';
import { LifecycleSuggestions } from './LifecycleSuggestions';
import { StaleReferencesPanel } from './StaleReferencesPanel';
import { useRunDiscoveryNow } from './runDiscoveryNow';

const RUN_COLUMNS: readonly DataColumn<DiscoveryRunListItem>[] = [
  { id: 'started', label: 'Started', width: '11rem', render: run => formatRunTime(run.startedAt) },
  { id: 'trigger', label: 'Trigger', width: '8rem', render: run => triggerLabel(run.trigger) },
  {
    id: 'result',
    label: 'Result',
    width: '16rem',
    render: run => {
      const result = runResult(run);
      return <StatusChip tone={result.tone} label={result.label} data-testid={`discovery-run-result-${run.id}`} />;
    },
  },
  { id: 'summary', label: 'Summary', render: run => runChangeSummary(run.changes, run.mode) },
];

function RunNowButton({
  onClick,
  busy,
  variant = 'solid',
  testId,
}: {
  onClick: () => void;
  busy: boolean;
  variant?: 'solid' | 'outlined';
  testId: string;
}) {
  return (
    <ModelWriteAction>
      {disabled => (
        <Button
          size="sm"
          variant={variant}
          disabled={disabled || busy}
          loading={busy}
          loadingPosition="start"
          onClick={onClick}
          data-testid={testId}
        >
          Run now
        </Button>
      )}
    </ModelWriteAction>
  );
}

function StatusLine({ status, now }: { status: DiscoveryStatus; now: Date }) {
  const { openSection } = useModelsNavigation();
  const lastRun = status.lastRun;
  const failed = lastRun?.sources.filter(source => !source.ok) ?? [];
  const skipped = lastRun?.skippedSources ?? [];
  const next = nextScheduledRun(status.runs);
  const words = [
    'On',
    modeLabel(status.mode),
    policyLabel(status.autoEnable),
    lastRun ? lastRunCopy(lastRun, now) : 'Never run',
    ...(status.selfHost ? ['Self-hosted'] : []),
  ];
  return (
    <Stack gap={0.5} sx={{ minWidth: 0 }}>
      <Typography level="body-md" sx={{ color: 'admin.ink' }} data-testid="discovery-status-line">
        {words.join(' | ')}
      </Typography>
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-status-schedule">
        {next && `Next scheduled run about ${formatClock(next)}. `}
        {status.lastSuccessfulRunAt && `Last successful run ${formatRunTime(status.lastSuccessfulRunAt)}. `}
        <Link
          component="button"
          type="button"
          level="body-sm"
          onClick={() => void openSection('settings')}
          data-testid="discovery-settings-link"
        >
          Change in Settings
        </Link>
      </Typography>
      {failed.length > 0 && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-status-failures">
          Failed: {failed.map(source => `${source.name} (${source.error ?? 'no error recorded'})`).join(', ')}
        </Typography>
      )}
      {skipped.length > 0 && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-status-skipped">
          Skipped: {skipped.map(source => `${source.name} (${sourceSkipCopy(source.reason)})`).join(', ')}
        </Typography>
      )}
    </Stack>
  );
}

/** Models > Discovery. */
export function DiscoverySection() {
  const status = useDiscoveryStatus();
  const { runNow, busy, notice, error } = useRunDiscoveryNow();
  const { openRun, openSection } = useModelsNavigation();
  const data = status.data;

  const startRun = () => void runNow(run => void openRun(run.id));

  const statusRegion = status.isLoading ? (
    <Stack gap={1} data-testid="discovery-status-loading" aria-busy>
      <Skeleton variant="text" level="body-md" sx={{ width: '60%' }} />
      <Skeleton variant="text" level="body-sm" sx={{ width: '40%' }} />
    </Stack>
  ) : !data ? (
    <ErrorState
      message={apiErrorMessage(status.error, 'Could not load discovery status')}
      onRetry={() => void status.refetch()}
      retrying={status.isFetching}
    />
  ) : !data.enabled ? (
    <Box data-testid="discovery-off">
      <EmptyState
        title={DISCOVERY_OFF_TITLE}
        description={DISCOVERY_OFF_DESCRIPTION}
        action={
          <Button
            variant="outlined"
            onClick={() => void openSection('settings')}
            data-testid="discovery-open-settings-btn"
          >
            Open settings
          </Button>
        }
      />
    </Box>
  ) : (
    <Stack gap={1.5}>
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} justifyContent="space-between" alignItems="flex-start">
        <StatusLine status={data} now={new Date()} />
        <Box sx={{ flexShrink: 0 }}>
          <RunNowButton onClick={startRun} busy={busy} testId="discovery-run-now-btn" />
        </Box>
      </Stack>
      {error && (
        <Alert color="danger" size="sm" data-testid="discovery-run-now-error">
          {error}
        </Alert>
      )}
      {notice && !error && (
        <Alert color="neutral" size="sm" data-testid="discovery-run-now-notice">
          {notice}
        </Alert>
      )}
    </Stack>
  );

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="discovery-section">
      <Stack gap={1}>
        <UpdatingBar active={status.isFetching && !status.isLoading && !!data} testId="discovery-updating" />
        {status.isError && data && (
          <Alert color="warning" variant="soft" size="sm" data-testid="discovery-status-refresh-error">
            Showing the last loaded status; the refresh failed:{' '}
            {apiErrorMessage(status.error, 'Could not load discovery status')}
          </Alert>
        )}
        {statusRegion}
      </Stack>
      {(status.isLoading || data) && (
        <Stack gap={1} data-testid="discovery-runs">
          <DataTable
            label="Discovery runs"
            testId="discovery-runs-table"
            rows={data?.runs ?? []}
            columns={RUN_COLUMNS}
            getRowId={run => run.id}
            loading={status.isLoading}
            onRetry={() => void status.refetch()}
            onRowActivate={run => void openRun(run.id)}
            rowTestId={run => `discovery-run-row-${run.id}`}
            pagination={false}
            empty={
              <Box data-testid="discovery-runs-empty">
                <EmptyState
                  title="No runs yet"
                  action={
                    data?.enabled ? (
                      <RunNowButton
                        onClick={startRun}
                        busy={busy}
                        variant="outlined"
                        testId="discovery-runs-empty-run-now-btn"
                      />
                    ) : null
                  }
                />
              </Box>
            }
          />
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-retention-note">
            {RUN_RETENTION_NOTE}
          </Typography>
        </Stack>
      )}
      <LifecycleSuggestions />
      <StaleReferencesPanel />
    </Stack>
  );
}
