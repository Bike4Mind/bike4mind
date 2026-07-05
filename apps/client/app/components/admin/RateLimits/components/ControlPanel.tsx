import React from 'react';
import { Box, Button, Chip, Input, Option, Select, Stack, Typography, Checkbox } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import ClearIcon from '@mui/icons-material/Clear';

interface ControlPanelProps {
  dateFrom: string;
  dateTo: string;
  integrationFilter: string;
  throttledOnly: boolean;
  summaryStats: { total: number; throttled: number; avgUsage: number };
  isLoading: boolean;
  setDateFrom: (v: string) => void;
  setDateTo: (v: string) => void;
  setIntegrationFilter: (v: string) => void;
  setThrottledOnly: (v: boolean) => void;
  onRefresh: () => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
}

const DATE_PRESETS = [
  {
    label: 'Last Hour',
    getRange: () => {
      const now = new Date();
      return { from: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    },
  },
  {
    label: 'Last 24h',
    getRange: () => {
      const now = new Date();
      return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    },
  },
  {
    label: 'Last 7 Days',
    getRange: () => {
      const now = new Date();
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    },
  },
  {
    label: 'Last 30 Days',
    getRange: () => {
      const now = new Date();
      return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    },
  },
];

export const ControlPanel: React.FC<ControlPanelProps> = ({
  dateFrom,
  dateTo,
  integrationFilter,
  throttledOnly,
  summaryStats,
  isLoading,
  setDateFrom,
  setDateTo,
  setIntegrationFilter,
  setThrottledOnly,
  onRefresh,
  onApplyFilters,
  onClearFilters,
}) => {
  return (
    <Box data-testid="rate-limit-control-panel" sx={{ mb: 3 }}>
      {/* Summary chips */}
      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap">
        <Chip variant="soft" color="neutral">
          {summaryStats.total} snapshots
        </Chip>
        <Chip variant="soft" color={summaryStats.throttled > 0 ? 'danger' : 'success'}>
          {summaryStats.throttled} throttled
        </Chip>
        <Chip variant="soft" color={summaryStats.avgUsage > 80 ? 'warning' : 'neutral'}>
          {summaryStats.avgUsage}% avg usage
        </Chip>
      </Stack>

      {/* Date presets */}
      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap">
        {DATE_PRESETS.map(preset => (
          <Button
            key={preset.label}
            size="sm"
            variant="outlined"
            onClick={() => {
              const range = preset.getRange();
              setDateFrom(range.from);
              setDateTo(range.to);
            }}
          >
            {preset.label}
          </Button>
        ))}
      </Stack>

      {/* Filters row */}
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Input
          type="datetime-local"
          size="sm"
          value={dateFrom ? dateFrom.slice(0, 16) : ''}
          onChange={e => setDateFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
          slotProps={{ input: { 'aria-label': 'Date from' } }}
        />
        <Typography level="body-sm">to</Typography>
        <Input
          type="datetime-local"
          size="sm"
          value={dateTo ? dateTo.slice(0, 16) : ''}
          onChange={e => setDateTo(e.target.value ? new Date(e.target.value).toISOString() : '')}
          slotProps={{ input: { 'aria-label': 'Date to' } }}
        />
        <Select
          data-testid="rate-limit-integration-select"
          size="sm"
          value={integrationFilter}
          onChange={(_, v) => setIntegrationFilter(v || '')}
          placeholder="All Integrations"
          sx={{ minWidth: 160 }}
        >
          <Option value="">All Integrations</Option>
          <Option value="github">GitHub</Option>
          <Option value="jira">Jira</Option>
          <Option value="confluence">Confluence</Option>
          <Option value="slack">Slack</Option>
        </Select>
        <Checkbox
          size="sm"
          label="Throttled Only"
          checked={throttledOnly}
          onChange={e => setThrottledOnly(e.target.checked)}
        />
        <Button
          data-testid="rate-limit-apply-btn"
          size="sm"
          startDecorator={<FilterAltIcon />}
          onClick={onApplyFilters}
          loading={isLoading}
        >
          Apply
        </Button>
        <Button
          data-testid="rate-limit-clear-btn"
          size="sm"
          variant="outlined"
          startDecorator={<ClearIcon />}
          onClick={onClearFilters}
        >
          Clear
        </Button>
        <Button
          data-testid="rate-limit-refresh-btn"
          size="sm"
          variant="soft"
          startDecorator={<RefreshIcon />}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </Stack>
    </Box>
  );
};
