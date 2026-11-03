import React from 'react';
import { Autocomplete, Button, Input, Option, Select, Stack, Typography } from '@mui/joy';
import {
  EMPTY_LEDGER_FILTER,
  SOURCE_FILTER_OPTIONS,
  hasLedgerFilter,
  isCompletionSource,
  isLedgerRangeInverted,
  type LedgerFilterState,
} from './creditLedgerModel';

type LedgerFilterBarProps = {
  value: LedgerFilterState;
  onChange: (next: LedgerFilterState) => void;
  /** Models to suggest; any other model id can still be typed. */
  modelOptions: readonly string[];
};

// Joy Select shows its placeholder for null but has no null option, so "any source" is the empty string.
const ANY_SOURCE = '';
// Native date inputs accept 5- and 6-digit years, which the server's ISO date check rejects.
const MIN_DAY = '2000-01-01';
const MAX_DAY = '9999-12-31';

/** Model, source and date-range filters for the ledger; the type filter sits in the row above. */
export const LedgerFilterBar: React.FC<LedgerFilterBarProps> = ({ value, onChange, modelOptions }) => {
  const patch = (partial: Partial<LedgerFilterState>) => onChange({ ...value, ...partial });
  const inverted = isLedgerRangeInverted(value);

  return (
    <Stack
      direction="row"
      flexWrap="wrap"
      alignItems="center"
      gap={1}
      sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'admin.border' }}
      data-testid="user-credits-filter-bar"
    >
      <Autocomplete
        size="sm"
        freeSolo
        autoSelect
        options={[...modelOptions]}
        value={value.model}
        onChange={(_, model) => patch({ model: model?.trim() || null })}
        placeholder="Any model"
        aria-label="Model"
        sx={{ width: 240 }}
        slotProps={{ input: { 'data-testid': 'user-credits-model-filter' } }}
      />
      <Select
        size="sm"
        value={value.source ?? ANY_SOURCE}
        onChange={(_, source) => patch({ source: source && isCompletionSource(source) ? source : null })}
        aria-label="Source"
        sx={{ minWidth: 140 }}
        slotProps={{ button: { 'data-testid': 'user-credits-source-filter' } }}
      >
        <Option value={ANY_SOURCE}>Any source</Option>
        {SOURCE_FILTER_OPTIONS.map(option => (
          <Option key={option.value} value={option.value} data-testid={`user-credits-source-option-${option.value}`}>
            {option.label}
          </Option>
        ))}
      </Select>
      <Input
        size="sm"
        type="date"
        value={value.from}
        onChange={event => patch({ from: event.target.value })}
        error={inverted}
        slotProps={{
          input: {
            'aria-label': 'From (UTC)',
            min: MIN_DAY,
            max: value.to || MAX_DAY,
            'data-testid': 'user-credits-from',
          },
        }}
      />
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        to
      </Typography>
      <Input
        size="sm"
        type="date"
        value={value.to}
        onChange={event => patch({ to: event.target.value })}
        error={inverted}
        slotProps={{
          input: {
            'aria-label': 'To (UTC)',
            min: value.from || MIN_DAY,
            max: MAX_DAY,
            'data-testid': 'user-credits-to',
          },
        }}
      />
      <Typography level="body-xs" sx={{ color: inverted ? 'admin.status.bad.foreground' : 'admin.inkMuted' }}>
        {inverted ? 'The start date is after the end date.' : 'UTC days, both included'}
      </Typography>
      {hasLedgerFilter(value) && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => onChange(EMPTY_LEDGER_FILTER)}
          data-testid="user-credits-clear-filters-btn"
        >
          Clear filters
        </Button>
      )}
    </Stack>
  );
};
