import React from 'react';
import { Button, Checkbox, Input, Option, Select, Stack, Typography } from '@mui/joy';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import ClearIcon from '@mui/icons-material/Clear';
import { adminFocusScope } from '../../shared/adminStyles';

interface ControlPanelProps {
  dateFrom: string;
  dateTo: string;
  integrationFilter: string;
  throttledOnly: boolean;
  isLoading: boolean;
  setDateFrom: (v: string) => void;
  setDateTo: (v: string) => void;
  setIntegrationFilter: (v: string) => void;
  setThrottledOnly: (v: boolean) => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
}

const DATE_PRESETS = [
  {
    label: 'Last hour',
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
    label: 'Last 7 days',
    getRange: () => {
      const now = new Date();
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    },
  },
  {
    label: 'Last 30 days',
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
  isLoading,
  setDateFrom,
  setDateTo,
  setIntegrationFilter,
  setThrottledOnly,
  onApplyFilters,
  onClearFilters,
}) => {
  return (
    <Stack
      data-testid="rate-limit-control-panel"
      direction="row"
      flexWrap="wrap"
      alignItems="center"
      gap={1}
      sx={{
        ...adminFocusScope,
        // One height for every control so the row reads as a single toolbar when it wraps.
        '& .MuiInput-root, & .MuiSelect-root, & .MuiButton-root': { minHeight: 32 },
      }}
    >
      {DATE_PRESETS.map(preset => (
        <Button
          key={preset.label}
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={() => {
            const range = preset.getRange();
            setDateFrom(range.from);
            setDateTo(range.to);
          }}
        >
          {preset.label}
        </Button>
      ))}
      <Input
        type="datetime-local"
        size="sm"
        value={dateFrom ? dateFrom.slice(0, 16) : ''}
        onChange={e => setDateFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
        slotProps={{ input: { 'aria-label': 'Date from' } }}
      />
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        to
      </Typography>
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
        placeholder="All integrations"
        aria-label="Integration"
        sx={{ minWidth: 160 }}
      >
        <Option value="">All integrations</Option>
        <Option value="github">GitHub</Option>
        <Option value="jira">Jira</Option>
        <Option value="confluence">Confluence</Option>
        <Option value="slack">Slack</Option>
      </Select>
      <Checkbox
        size="sm"
        label="Throttled only"
        checked={throttledOnly}
        onChange={e => setThrottledOnly(e.target.checked)}
        sx={{ px: 0.5 }}
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
        variant="plain"
        color="neutral"
        startDecorator={<ClearIcon />}
        onClick={onClearFilters}
      >
        Clear
      </Button>
    </Stack>
  );
};
