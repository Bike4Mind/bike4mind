import React, { useState } from 'react';
import { Alert, Box, Button, Stack } from '@mui/joy';
import { AdminPageHeader, EmptyState, ErrorState, LoadingState } from '@client/app/components/admin/shared';
import { ADMIN_REGION_GAP, adminSurface } from '@client/app/components/admin/shared/adminStyles';
import { useIntegrationHealthDashboard } from './hooks/useIntegrationHealthDashboard';
import { useCircuitBreakerOverride } from './hooks/useCircuitBreakerOverride';
import { ControlPanel } from './components/ControlPanel';
import { IntegrationCard } from './components/IntegrationCard';
import { exportDashboardCsv } from './utils/csvExport';
import type { IntegrationName, TimeRange } from './types';

const AdminIntegrationHealthTab: React.FC = () => {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [expandedIntegration, setExpandedIntegration] = useState<IntegrationName | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const { data, isLoading, isRefetching, isError, error, runProbes, isRunningProbes, probeError, forceRefresh } =
    useIntegrationHealthDashboard(timeRange);
  const { setOverride, isUpdating, updatingIntegration } = useCircuitBreakerOverride();

  const handleToggle = (name: IntegrationName) => {
    setExpandedIntegration(prev => (prev === name ? null : name));
  };

  const handleExport = () => {
    if (!data) return;
    try {
      exportDashboardCsv(data);
      setExportError(null);
    } catch {
      setExportError('The CSV could not be exported. Try again.');
    }
  };

  const hasData = !!data && data.integrations.length > 0;

  const runProbesButton = (testId: string) => (
    <Button size="sm" onClick={() => runProbes(undefined)} loading={isRunningProbes} data-testid={testId}>
      Run probes
    </Button>
  );

  let body: React.ReactNode;
  if (isLoading) {
    body = <LoadingState label="Loading integration health" />;
  } else if (isError) {
    body = (
      <Box data-testid="integration-health-error-state">
        <ErrorState
          message={`Integration health failed to load: ${error?.message || 'unknown error'}`}
          onRetry={forceRefresh}
          retrying={isRefetching}
        />
      </Box>
    );
  } else if (!hasData) {
    body = (
      <Box data-testid="integration-health-empty-state">
        <EmptyState
          title="No integration health data yet"
          description="Run the probes to check each integration."
          action={runProbesButton('integration-health-empty-run-probes-btn')}
        />
      </Box>
    );
  } else {
    body = (
      <>
        <ControlPanel timeRange={timeRange} onTimeRangeChange={setTimeRange} isRefetching={isRefetching} data={data} />
        {/* One surface for the list: rows are divided by hairlines, not stacked as separate cards. */}
        <Box
          data-testid="integration-health-list"
          sx={{
            ...adminSurface,
            border: '1px solid',
            borderColor: 'admin.border',
            borderRadius: 'lg',
            overflow: 'hidden',
            '& > * + *': { borderTop: '1px solid', borderColor: 'admin.border' },
          }}
        >
          {data.integrations.map(entry => (
            <IntegrationCard
              key={entry.name}
              entry={entry}
              isExpanded={expandedIntegration === entry.name}
              onToggle={() => handleToggle(entry.name)}
              inMemoryBreakers={data.inMemoryBreakerStates}
              onOverride={(integration, mode, reason) => setOverride({ integration, mode, reason })}
              isUpdatingOverride={isUpdating && updatingIntegration === entry.name}
            />
          ))}
        </Box>
      </>
    );
  }

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Integrations"
        description="Probe results, circuit breakers and rate limits for Slack, GitHub, Jira and Confluence."
        actions={
          <>
            {runProbesButton('integration-health-run-probes-btn')}
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={forceRefresh}
              loading={isRefetching}
              data-testid="integration-health-refresh-btn"
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={handleExport}
              disabled={!hasData}
              data-testid="integration-health-export-btn"
            >
              Export CSV
            </Button>
          </>
        }
      />
      {probeError && (
        <Alert color="warning" variant="soft" data-testid="probe-error-alert">
          Probe failed: {probeError.message || 'unknown error'}
        </Alert>
      )}
      {exportError && (
        <Alert
          color="warning"
          variant="soft"
          endDecorator={
            <Button size="sm" variant="plain" color="neutral" onClick={() => setExportError(null)}>
              Dismiss
            </Button>
          }
        >
          {exportError}
        </Alert>
      )}
      {body}
    </Stack>
  );
};

export default AdminIntegrationHealthTab;
