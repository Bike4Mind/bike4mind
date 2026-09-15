import React, { useState } from 'react';
import { Alert, Box, Button, LinearProgress, Stack, Typography } from '@mui/joy';
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
      setExportError('Failed to export CSV. Please try again.');
    }
  };

  if (isLoading) {
    return (
      <Box sx={{ p: 6 }}>
        <LinearProgress />
        <Typography level="body-sm" sx={{ mt: 1, color: 'text.secondary' }}>
          Loading integration health data...
        </Typography>
      </Box>
    );
  }

  if (isError) {
    return (
      <Box sx={{ p: 6 }} data-testid="integration-health-error-state">
        <Alert color="danger" variant="soft" sx={{ mb: 2 }}>
          Failed to load integration health data: {error?.message || 'Unknown error'}
        </Alert>
        <Button variant="outlined" color="neutral" onClick={forceRefresh}>
          Retry
        </Button>
      </Box>
    );
  }

  if (!data || data.integrations.length === 0) {
    return (
      <Box sx={{ p: 6, textAlign: 'center' }} data-testid="integration-health-empty-state">
        <Typography level="h4" color="neutral">
          No integration health data yet
        </Typography>
        <Typography level="body-sm" color="neutral" sx={{ mt: 1 }}>
          Health check probes will populate this dashboard. Click &quot;Run Probes&quot; to start.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 6 } }}>
      {probeError && (
        <Alert color="warning" variant="soft" sx={{ mb: 2 }} data-testid="probe-error-alert">
          Probe failed: {probeError.message || 'Unknown error'}
        </Alert>
      )}
      {exportError && (
        <Alert
          color="warning"
          variant="soft"
          sx={{ mb: 2 }}
          endDecorator={
            <Button size="sm" variant="plain" color="warning" onClick={() => setExportError(null)}>
              Dismiss
            </Button>
          }
        >
          {exportError}
        </Alert>
      )}
      <ControlPanel
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        onRunProbes={() => runProbes(undefined)}
        onRefresh={forceRefresh}
        onExportCsv={handleExport}
        isRunningProbes={isRunningProbes}
        isRefetching={isRefetching}
        data={data}
      />

      <Stack spacing={2}>
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
      </Stack>
    </Box>
  );
};

export default AdminIntegrationHealthTab;
