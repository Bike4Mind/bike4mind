import { Button, Input, Option, Select, Stack } from '@mui/joy';
import type { AdminListState } from './useAdminListUrlState';
import { adminFocus, adminFocusScope } from './adminStyles';

export type AdminFilter = { id: string; label: string; options: readonly { value: string; label: string }[] };
export function FilterBar({
  state,
  filters = [],
  onChange,
  searchLabel = 'Search records',
  search = true,
}: {
  state: AdminListState;
  filters?: readonly AdminFilter[];
  onChange: (patch: Partial<AdminListState>) => void;
  searchLabel?: string;
  search?: boolean;
}) {
  return (
    <Stack sx={adminFocusScope} direction="row" flexWrap="wrap" gap={1} data-testid="admin-filter-bar">
      {search && (
        <Input
          value={state.query}
          placeholder={`${searchLabel} (/)`}
          slotProps={{
            input: {
              'aria-label': searchLabel,
              'data-admin-search': true,
              'aria-keyshortcuts': '/',
              'data-testid': 'admin-filter-search-input',
              maxLength: 500,
            },
          }}
          sx={{ ...adminFocus, flex: '1 1 12rem' }}
          onChange={event => onChange({ query: event.target.value, view: '' })}
        />
      )}
      {filters.map(filter => (
        <Stack key={filter.id} direction="row" gap={1}>
          <Select
            aria-label={filter.label}
            placeholder={filter.label}
            value={state.filters[filter.id] || null}
            data-testid={`admin-filter-${filter.id}`}
            sx={{ borderStyle: state.filters[filter.id] ? 'solid' : 'dashed' }}
            onChange={(_, value) => onChange({ filters: { ...state.filters, [filter.id]: value ?? '' }, view: '' })}
          >
            {filter.options.map(option => (
              <Option key={option.value} value={option.value} data-testid={`admin-filter-${filter.id}-${option.value}`}>
                {option.label}
              </Option>
            ))}
          </Select>
          {state.filters[filter.id] && (
            <Button
              variant="plain"
              aria-label={`Clear ${filter.label}`}
              data-testid={`admin-filter-clear-${filter.id}-btn`}
              onClick={() => onChange({ filters: { ...state.filters, [filter.id]: '' }, view: '' })}
            >
              Clear
            </Button>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
