import { useMemo, useState } from 'react';
import { Button, Dropdown, Menu, MenuButton, MenuItem, Stack, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import { PREDEFINED_USER_TAGS } from '@bike4mind/common';
import { useGetUserTags } from '@client/app/hooks/data/user';
import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import {
  USER_PLAN_FILTERS,
  USER_RISK_FILTERS,
  USER_SIGNED_UP_FILTERS,
  USER_SIGNUP_METHOD_FILTERS,
  USER_STATUS_FILTERS,
} from '@client/app/utils/adminUsersFilter';
import { AdminSearchInput } from '../../shared/FilterBar';
import { FilterChip, type FilterChipOption } from '../../shared/FilterChip';
import { SegmentedControl } from '../../shared/SegmentedControl';
import { adminFocus, adminFocusScope } from '../../shared/adminStyles';
import {
  CLEARED_FILTER_PARAMS,
  countActiveFilters,
  type UsersFilterKey,
  type UsersListParams,
} from '../usersTabSearch';
import { PLAN_LABELS, SIGNUP_METHOD_LABELS } from './usersColumns';

const capitalize = (value: string) => value[0].toUpperCase() + value.slice(1);

const SINGLE_FILTERS: { key: Exclude<UsersFilterKey, 'emailDomain'>; label: string; options: FilterChipOption[] }[] = [
  { key: 'status', label: 'Status', options: USER_STATUS_FILTERS.map(value => ({ value, label: capitalize(value) })) },
  { key: 'plan', label: 'Plan', options: USER_PLAN_FILTERS.map(value => ({ value, label: PLAN_LABELS[value] })) },
  { key: 'risk', label: 'Risk', options: USER_RISK_FILTERS.map(value => ({ value, label: capitalize(value) })) },
  {
    key: 'signedUp',
    label: 'Signed up',
    options: USER_SIGNED_UP_FILTERS.map(value => ({ value, label: `Last ${value}` })),
  },
  {
    key: 'signupMethod',
    label: 'Sign-in method',
    options: USER_SIGNUP_METHOD_FILTERS.map(value => ({ value, label: SIGNUP_METHOD_LABELS[value] })),
  },
  {
    key: 'verified',
    label: 'Email verified',
    options: [
      { value: 'yes', label: 'Verified' },
      { value: 'no', label: 'Not verified' },
    ],
  },
  {
    key: 'hasApiKey',
    label: 'API keys',
    options: [
      { value: 'yes', label: 'Has keys' },
      { value: 'no', label: 'No keys' },
    ],
  },
];
/** Shown up front; the rest wait behind "Filter" until picked or set. */
const PRIMARY_FILTERS = new Set<string>(['status', 'plan', 'risk', 'signedUp']);
type ExtraFilter = Exclude<UsersFilterKey, 'emailDomain'> | 'organization' | 'tags';

/** The signup chart's window as chip text; the end is exclusive. */
export const formatCreatedWindow = (from: string | undefined, to: string | undefined) =>
  `${from ? new Date(from).toLocaleString() : 'any time'} to ${to ? new Date(to).toLocaleString() : 'now'}`;

export function UsersToolbar({
  params,
  search,
  onSearchChange,
  onChange,
}: {
  params: UsersListParams;
  search: string;
  onSearchChange: (search: string) => void;
  onChange: (patch: Partial<UsersListParams>) => void;
}) {
  const [revealed, setRevealed] = useState<ReadonlySet<ExtraFilter>>(new Set());
  const organizations = useGetAllOrganizations({ filters: { personal: false } });
  const userTags = useGetUserTags();

  const organizationOptions = useMemo<FilterChipOption[]>(
    () => [
      { value: 'Unassigned', label: 'No organization' },
      ...(organizations.data ?? []).map(organization => ({ value: organization.name, label: organization.name })),
    ],
    [organizations.data]
  );
  const tagOptions = useMemo<FilterChipOption[]>(
    () =>
      Array.from(new Set(['Admin', ...PREDEFINED_USER_TAGS, ...(userTags.data ?? [])])).map(tag => ({
        value: tag,
        label: tag,
      })),
    [userTags.data]
  );
  const selectedOrganizations = params.orgSearch.filter(name => name !== 'all');

  const isShown = (key: ExtraFilter) => PRIMARY_FILTERS.has(key) || revealed.has(key);
  const isSet = (key: ExtraFilter) =>
    key === 'organization'
      ? selectedOrganizations.length > 0
      : key === 'tags'
        ? params.tags.length > 0
        : params[key] !== undefined;
  const hidden: { key: ExtraFilter; label: string }[] = [
    ...SINGLE_FILTERS.filter(filter => !isShown(filter.key) && !isSet(filter.key)),
    ...(isShown('organization') || isSet('organization')
      ? []
      : [{ key: 'organization' as const, label: 'Organization' }]),
    ...(isShown('tags') || isSet('tags') ? [] : [{ key: 'tags' as const, label: 'Tags' }]),
  ];
  const activeFilters = countActiveFilters(params);
  const update = (patch: Partial<UsersListParams>) => onChange({ ...patch, page: 1 });

  return (
    <Stack gap={1.25} sx={adminFocusScope} data-testid="admin-users-toolbar">
      <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
        <AdminSearchInput
          value={search}
          onChange={onSearchChange}
          label="Search name, email or user ID"
          data-testid="admin-users-search-input"
        />
        <Stack direction="row" alignItems="center" gap={1} sx={{ ml: { md: 'auto' } }}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted', whiteSpace: 'nowrap' }}>
            Group by
          </Typography>
          <SegmentedControl
            aria-label="Group by"
            data-testid="admin-users-group-by"
            value={params.groupBy ?? 'none'}
            options={[
              { value: 'none', label: 'None' },
              { value: 'emailDomain', label: 'Email domain' },
            ]}
            onChange={value => onChange({ groupBy: value === 'emailDomain' ? 'emailDomain' : undefined, page: 1 })}
          />
        </Stack>
      </Stack>
      <Stack direction="row" alignItems="center" flexWrap="wrap" gap={0.75} data-testid="admin-users-filters">
        {SINGLE_FILTERS.filter(filter => isShown(filter.key) || isSet(filter.key)).map(filter => (
          <FilterChip
            key={filter.key}
            id={filter.key}
            label={filter.label}
            options={filter.options}
            value={params[filter.key]}
            // The chip's options are this filter's own values, so the key and value stay paired.
            onChange={value => update({ [filter.key]: value } as Partial<UsersListParams>)}
          />
        ))}
        {(isShown('organization') || isSet('organization')) && (
          <FilterChip
            multiple
            id="organization"
            label="Organization"
            options={organizationOptions}
            value={selectedOrganizations}
            onChange={names => update({ orgSearch: names.length > 0 ? names : ['all'] })}
          />
        )}
        {(isShown('tags') || isSet('tags')) && (
          <FilterChip
            multiple
            id="tags"
            label="Tags"
            options={tagOptions}
            value={params.tags}
            onChange={tags => update({ tags })}
          />
        )}
        {params.emailDomain && (
          <FilterChip
            id="emailDomain"
            label="Domain"
            options={[{ value: params.emailDomain, label: params.emailDomain }]}
            value={params.emailDomain}
            onChange={value => update({ emailDomain: value })}
          />
        )}
        {(params.createdFrom || params.createdTo) && (
          <FilterChip
            id="createdWindow"
            label="Created"
            options={[{ value: 'window', label: formatCreatedWindow(params.createdFrom, params.createdTo) }]}
            value="window"
            onChange={value => {
              if (value === undefined) update({ createdFrom: undefined, createdTo: undefined });
            }}
          />
        )}
        {hidden.length > 0 && (
          <Dropdown>
            <MenuButton
              size="sm"
              variant="plain"
              startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
              data-testid="admin-users-add-filter-btn"
              sx={{
                ...adminFocus,
                minHeight: 30,
                height: 30,
                fontSize: 13,
                color: 'admin.inkMuted',
                borderRadius: '8px',
              }}
            >
              Filter
            </MenuButton>
            <Menu size="sm" placement="bottom-start" sx={{ zIndex: 1300 }}>
              {hidden.map(filter => (
                <MenuItem
                  key={filter.key}
                  data-testid={`admin-users-add-filter-${filter.key}`}
                  onClick={() => setRevealed(current => new Set([...current, filter.key]))}
                >
                  {filter.label}
                </MenuItem>
              ))}
            </Menu>
          </Dropdown>
        )}
        {activeFilters > 0 && (
          <Button
            size="sm"
            variant="plain"
            data-testid="admin-users-clear-filters-btn"
            onClick={() => {
              setRevealed(new Set());
              onChange(CLEARED_FILTER_PARAMS);
            }}
            sx={{ ...adminFocus, minHeight: 30, height: 30, fontSize: 13, color: 'admin.link' }}
          >
            Clear filters
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
