import { Input, Stack } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import type { AdminListState } from './useAdminListUrlState';
import { FilterChip } from './FilterChip';
import { adminFocus, adminFocusScope } from './adminStyles';

export type AdminFilter = { id: string; label: string; options: readonly { value: string; label: string }[] };

/** The 34 px list search box; the Users list and FilterBar share it. */
export function AdminSearchInput({
  value,
  onChange,
  label,
  'data-testid': testId = 'admin-filter-search-input',
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  'data-testid'?: string;
}) {
  return (
    <Input
      value={value}
      placeholder={`${label} (/)`}
      size="sm"
      startDecorator={<SearchIcon sx={{ fontSize: 16, color: 'admin.inkMuted' }} />}
      slotProps={{
        input: {
          'aria-label': label,
          'data-admin-search': true,
          'aria-keyshortcuts': '/',
          'data-testid': testId,
          maxLength: 500,
        },
      }}
      sx={{ ...adminFocus, flex: '1 1 16rem', minWidth: '12rem', maxWidth: '26rem', minHeight: 34, fontSize: 13 }}
      onChange={event => onChange(event.target.value)}
    />
  );
}

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
    <Stack
      sx={adminFocusScope}
      direction="row"
      flexWrap="wrap"
      alignItems="center"
      gap={1}
      data-testid="admin-filter-bar"
    >
      {search && (
        <AdminSearchInput value={state.query} label={searchLabel} onChange={query => onChange({ query, view: '' })} />
      )}
      {filters.map(filter => (
        <FilterChip
          key={filter.id}
          id={filter.id}
          label={filter.label}
          value={state.filters[filter.id] || undefined}
          options={filter.options}
          onChange={value => onChange({ filters: { ...state.filters, [filter.id]: value ?? '' }, view: '' })}
        />
      ))}
    </Stack>
  );
}
