import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Chip, ChipDelete, FormControl, FormLabel, Input, Option, Select, Stack } from '@mui/joy';
import dayjs from 'dayjs';
import { AGENT_EXECUTION_STATUSES, type AgentExecutionStatus } from '@client/app/stores/useAgentExecutionStore';
import type { AgentExecutionsListFilters } from '@client/app/hooks/data/agentExecutions';

const TEXT_INPUT_DEBOUNCE_MS = 300;

export type DateRangePreset = 'all' | '24h' | '7d' | '30d';

const DATE_PRESET_LABELS: Record<DateRangePreset, string> = {
  all: 'All time',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

const STATUS_LABEL: Record<AgentExecutionStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  continuing: 'Running',
  awaiting_permission: 'Awaiting permission',
  awaiting_subagent: 'Awaiting subagent',
  awaiting_dag_children: 'Awaiting DAG children',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
};

// `continuing` is a transient internal state - collapsed under "Running" for
// the filter UI so users don't see two near-identical options.
const FILTERABLE_STATUSES: AgentExecutionStatus[] = AGENT_EXECUTION_STATUSES.filter(s => s !== 'continuing');

export interface HistoryFilterState {
  statuses: AgentExecutionStatus[];
  datePreset: DateRangePreset;
  model: string;
  minCredits: string;
  maxCredits: string;
}

export const EMPTY_FILTER_STATE: HistoryFilterState = {
  statuses: [],
  datePreset: 'all',
  model: '',
  minCredits: '',
  maxCredits: '',
};

/** Translates UI filter state into the wire-format the list hook expects. */
export function filterStateToQuery(state: HistoryFilterState): AgentExecutionsListFilters {
  const filters: AgentExecutionsListFilters = {};
  if (state.statuses.length) {
    // Expand "Running" to include the internal `continuing` state.
    filters.status = state.statuses.flatMap(s =>
      s === 'running' ? (['running', 'continuing'] as AgentExecutionStatus[]) : [s]
    );
  }
  if (state.model.trim()) filters.model = [state.model.trim()];
  const min = Number(state.minCredits);
  if (state.minCredits !== '' && Number.isFinite(min) && min >= 0) filters.minCredits = min;
  const max = Number(state.maxCredits);
  if (state.maxCredits !== '' && Number.isFinite(max) && max >= 0) filters.maxCredits = max;
  if (state.datePreset !== 'all') {
    const unit = state.datePreset === '24h' ? 24 : state.datePreset === '7d' ? 24 * 7 : 24 * 30;
    filters.from = dayjs().subtract(unit, 'hour').toISOString();
  }
  return filters;
}

interface HistoryFiltersProps {
  value: HistoryFilterState;
  onChange: (next: HistoryFilterState) => void;
}

const HistoryFilters: FC<HistoryFiltersProps> = ({ value, onChange }) => {
  // Local mirror for text/number inputs - typed values are propagated to the
  // parent through a debounced effect so each keystroke doesn't fire a fetch.
  // Status chips and the date preset stay un-debounced; they're discrete clicks.
  const [localText, setLocalText] = useState({
    model: value.model,
    minCredits: value.minCredits,
    maxCredits: value.maxCredits,
  });

  // Resync local state when the parent resets (e.g. Clear filters). Compared
  // by value, not reference, so an unrelated parent re-render with the same
  // strings doesn't clobber an in-flight keystroke.
  const lastSyncedRef = useRef({ model: value.model, minCredits: value.minCredits, maxCredits: value.maxCredits });
  useEffect(() => {
    const synced = lastSyncedRef.current;
    if (
      synced.model !== value.model ||
      synced.minCredits !== value.minCredits ||
      synced.maxCredits !== value.maxCredits
    ) {
      lastSyncedRef.current = { model: value.model, minCredits: value.minCredits, maxCredits: value.maxCredits };
      setLocalText({ model: value.model, minCredits: value.minCredits, maxCredits: value.maxCredits });
    }
  }, [value.model, value.minCredits, value.maxCredits]);

  // Debounced propagation. Skip if the local values already match what the
  // parent has - avoids an extra onChange after an external reset.
  useEffect(() => {
    if (
      localText.model === value.model &&
      localText.minCredits === value.minCredits &&
      localText.maxCredits === value.maxCredits
    ) {
      return;
    }
    const timer = setTimeout(() => {
      lastSyncedRef.current = {
        model: localText.model,
        minCredits: localText.minCredits,
        maxCredits: localText.maxCredits,
      };
      onChange({
        ...value,
        model: localText.model,
        minCredits: localText.minCredits,
        maxCredits: localText.maxCredits,
      });
    }, TEXT_INPUT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [localText, value, onChange]);

  const toggleStatus = useCallback(
    (status: AgentExecutionStatus) => {
      const next = value.statuses.includes(status)
        ? value.statuses.filter(s => s !== status)
        : [...value.statuses, status];
      onChange({ ...value, statuses: next });
    },
    [value, onChange]
  );

  return (
    <Stack
      direction="column"
      spacing={2}
      data-testid="history-filters"
      sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}
    >
      <Box>
        <FormLabel sx={{ mb: 1 }}>Status</FormLabel>
        <Stack direction="row" flexWrap="wrap" gap={0.75}>
          {FILTERABLE_STATUSES.map(status => {
            const selected = value.statuses.includes(status);
            return (
              <Chip
                key={status}
                variant={selected ? 'solid' : 'outlined'}
                color={selected ? 'primary' : 'neutral'}
                onClick={() => toggleStatus(status)}
                data-testid={`history-filter-status-${status}`}
                // Toggle chips behave as buttons; expose state to assistive
                // tech via the interactive `action` slot so screen readers
                // announce selected vs. unselected alongside the visible
                // solid/outlined treatment.
                slotProps={{ action: { 'aria-pressed': selected } }}
                endDecorator={selected ? <ChipDelete onClick={() => toggleStatus(status)} /> : null}
              >
                {STATUS_LABEL[status]}
              </Chip>
            );
          })}
        </Stack>
      </Box>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'flex-end' }}>
        <FormControl sx={{ minWidth: 180 }}>
          <FormLabel>Date</FormLabel>
          <Select
            value={value.datePreset}
            onChange={(_, v) => v && onChange({ ...value, datePreset: v as DateRangePreset })}
            data-testid="history-filter-date"
          >
            {(Object.keys(DATE_PRESET_LABELS) as DateRangePreset[]).map(preset => (
              <Option key={preset} value={preset}>
                {DATE_PRESET_LABELS[preset]}
              </Option>
            ))}
          </Select>
        </FormControl>

        <FormControl sx={{ minWidth: 200, flex: 1 }}>
          <FormLabel>Model</FormLabel>
          <Input
            value={localText.model}
            placeholder="e.g. claude-opus-4-7"
            onChange={e => setLocalText(prev => ({ ...prev, model: e.target.value }))}
            slotProps={{ input: { 'data-testid': 'history-filter-model' } }}
          />
        </FormControl>

        <FormControl sx={{ width: 120 }}>
          <FormLabel>Min credits</FormLabel>
          <Input
            type="number"
            value={localText.minCredits}
            slotProps={{ input: { min: 0, 'data-testid': 'history-filter-min-credits' } }}
            onChange={e => setLocalText(prev => ({ ...prev, minCredits: e.target.value }))}
          />
        </FormControl>

        <FormControl sx={{ width: 120 }}>
          <FormLabel>Max credits</FormLabel>
          <Input
            type="number"
            value={localText.maxCredits}
            slotProps={{ input: { min: 0, 'data-testid': 'history-filter-max-credits' } }}
            onChange={e => setLocalText(prev => ({ ...prev, maxCredits: e.target.value }))}
          />
        </FormControl>
      </Stack>
    </Stack>
  );
};

export default HistoryFilters;
