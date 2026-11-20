import React from 'react';
import { Stack, Typography } from '@mui/joy';
import { SegmentedControl, StatusChip } from '@client/app/components/admin/shared';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import type { TimeRange, IntegrationDashboardResponse } from '../types';
import { integrationStatusView } from '../utils/integrationStatus';

interface ControlPanelProps {
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  isRefetching: boolean;
  data: IntegrationDashboardResponse;
}

const TIME_RANGE_OPTIONS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
] as const satisfies readonly { value: TimeRange; label: string }[];

/** Time range, a status count per tone, and when the data was last fetched. */
export const ControlPanel: React.FC<ControlPanelProps> = ({ timeRange, onTimeRangeChange, isRefetching, data }) => {
  const counts = new Map<string, { tone: AdminStatusTone; label: string; count: number }>();
  for (const entry of data.integrations) {
    const { tone, label } = integrationStatusView(entry);
    const current = counts.get(label);
    counts.set(label, { tone, label, count: (current?.count ?? 0) + 1 });
  }

  return (
    <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1} data-testid="integration-health-control-panel">
      <SegmentedControl
        options={TIME_RANGE_OPTIONS}
        value={timeRange}
        onChange={onTimeRangeChange}
        aria-label="Time range"
        data-testid="time-range-btn"
      />
      {[...counts.values()].map(({ tone, label, count }) => (
        <StatusChip
          key={label}
          tone={tone}
          label={`${count} ${label.toLowerCase()}`}
          data-testid={`integration-health-count-${tone}`}
        />
      ))}
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted', ml: 'auto' }}>
        {isRefetching ? 'Updating' : `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}, refreshes every 30
        seconds
      </Typography>
    </Stack>
  );
};
