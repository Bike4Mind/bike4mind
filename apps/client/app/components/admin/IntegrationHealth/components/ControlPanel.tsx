import React from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';
import type { TimeRange, IntegrationDashboardResponse } from '../types';

interface ControlPanelProps {
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  onRunProbes: () => void;
  onRefresh: () => void;
  onExportCsv: () => void;
  isRunningProbes: boolean;
  isRefetching: boolean;
  data: IntegrationDashboardResponse | null;
}

const TIME_RANGES: TimeRange[] = ['24h', '7d', '30d'];

export const ControlPanel: React.FC<ControlPanelProps> = ({
  timeRange,
  onTimeRangeChange,
  onRunProbes,
  onRefresh,
  onExportCsv,
  isRunningProbes,
  isRefetching,
  data,
}) => {
  const healthyCt = data?.integrations.filter(i => i.status === 'healthy').length ?? 0;
  const degradedCt = data?.integrations.filter(i => i.status === 'degraded').length ?? 0;
  const unhealthyCt = data?.integrations.filter(i => i.status === 'unhealthy').length ?? 0;

  return (
    <Box data-testid="integration-health-control-panel" sx={{ mb: 3 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        spacing={2}
        sx={{ mb: 2 }}
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="h4">Integration Health</Typography>
          {data && (
            <Stack direction="row" spacing={0.5}>
              {healthyCt > 0 && (
                <Chip size="sm" color="success" variant="soft">
                  {healthyCt} Healthy
                </Chip>
              )}
              {degradedCt > 0 && (
                <Chip size="sm" color="warning" variant="soft">
                  {degradedCt} Degraded
                </Chip>
              )}
              {unhealthyCt > 0 && (
                <Chip size="sm" color="danger" variant="soft">
                  {unhealthyCt} Down
                </Chip>
              )}
            </Stack>
          )}
        </Stack>

        <Stack direction="row" spacing={1} flexWrap="wrap">
          <Stack direction="row" spacing={0.5}>
            {TIME_RANGES.map(range => (
              <Button
                key={range}
                size="sm"
                variant={timeRange === range ? 'solid' : 'outlined'}
                onClick={() => onTimeRangeChange(range)}
                data-testid={`time-range-btn-${range}`}
              >
                {range}
              </Button>
            ))}
          </Stack>

          <Button
            size="sm"
            variant="outlined"
            startDecorator={<PlayArrowIcon />}
            onClick={onRunProbes}
            loading={isRunningProbes}
            data-testid="integration-health-run-probes-btn"
          >
            Run Probes
          </Button>
          <Button
            size="sm"
            variant="outlined"
            startDecorator={<RefreshIcon />}
            onClick={onRefresh}
            loading={isRefetching}
            data-testid="integration-health-refresh-btn"
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outlined"
            startDecorator={<DownloadIcon />}
            onClick={onExportCsv}
            disabled={!data}
            data-testid="integration-health-export-btn"
          >
            Export CSV
          </Button>
        </Stack>
      </Stack>

      {data && (
        <Typography level="body-xs" color="neutral">
          Last updated: {new Date(data.generatedAt).toLocaleTimeString()} (auto-refreshes every 30s)
        </Typography>
      )}
    </Box>
  );
};
