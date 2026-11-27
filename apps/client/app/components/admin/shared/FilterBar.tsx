import type { ReactNode } from 'react';
import { Input, Stack, Typography } from '@mui/joy';
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

/**
 * A filter row for controls FilterBar has no slot for, such as date inputs: the same wrapping 8 px
 * row, with every input at one 32 px height so the row still reads as one toolbar when it wraps.
 */
export function FilterToolbar({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid': string }) {
  return (
    <Stack
      direction="row"
      flexWrap="wrap"
      alignItems="center"
      gap={1}
      data-testid={testId}
      sx={{ ...adminFocusScope, '& .MuiInput-root': { minHeight: 32 } }}
    >
      {children}
    </Stack>
  );
}

/** The muted label in a toolbar input's start decorator, such as "From" on a date input. */
export function FilterInputLabel({ children }: { children: ReactNode }) {
  return (
    <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
      {children}
    </Typography>
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
