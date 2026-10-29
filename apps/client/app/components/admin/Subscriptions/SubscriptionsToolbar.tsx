import { useMemo, useState } from 'react';
import { Button, Dropdown, Menu, MenuButton, MenuItem, Stack } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import { SUBSCRIPTION_STATUS_FILTERS, UNKNOWN_PLAN_FILTER } from '@client/app/utils/adminSubscriptionsFilter';
import { SUBSCRIPTION_PLANS, TEAM_PLAN } from '@client/lib/userSubscriptions/constants';
import { AdminSearchInput } from '../shared/FilterBar';
import { FilterChip, type FilterChipOption } from '../shared/FilterChip';
import { adminFocus, adminFocusScope } from '../shared/adminStyles';
import { SUBSCRIPTION_STATUS_DISPLAY } from './subscriptionStatusTone';
import {
  CLEARED_FILTER_PARAMS,
  countActiveFilters,
  parseStatusList,
  type SubscriptionsFilterKey,
  type SubscriptionsListParams,
} from './subscriptionsTabSearch';

const SOURCE_OPTIONS: FilterChipOption[] = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'admin_grant', label: 'Comped' },
];

/** Behind "Filter" until picked or set; Status, Source and Plan are always shown. */
const MORE_FILTERS: {
  key: Exclude<SubscriptionsFilterKey, 'status' | 'source' | 'plan'>;
  label: string;
  options: FilterChipOption[];
}[] = [
  {
    key: 'ownerType',
    label: 'Owner',
    options: [
      { value: 'User', label: 'Users' },
      { value: 'Organization', label: 'Organizations' },
    ],
  },
  {
    key: 'interval',
    label: 'Interval',
    options: [
      { value: 'monthly', label: 'Monthly' },
      { value: 'yearly', label: 'Yearly' },
    ],
  },
  {
    key: 'renews',
    label: 'Renews or ends',
    options: [
      { value: 'next7', label: 'Next 7 days' },
      { value: 'next30', label: 'Next 30 days' },
      { value: 'overdue', label: 'Overdue' },
    ],
  },
  {
    key: 'cancel',
    label: 'Cancellation',
    options: [
      { value: 'scheduled', label: 'Scheduled' },
      { value: 'last30', label: 'In the last 30 days' },
    ],
  },
];

const STATUS_OPTIONS: FilterChipOption[] = SUBSCRIPTION_STATUS_FILTERS.map(value => ({
  value,
  label: SUBSCRIPTION_STATUS_DISPLAY[value].label,
}));

export function SubscriptionsToolbar({
  params,
  search,
  onSearchChange,
  onChange,
}: {
  params: SubscriptionsListParams;
  search: string;
  onSearchChange: (search: string) => void;
  onChange: (patch: Partial<SubscriptionsListParams>) => void;
}) {
  const [revealed, setRevealed] = useState<ReadonlySet<SubscriptionsFilterKey>>(new Set());
  const planOptions = useMemo<FilterChipOption[]>(
    () => [
      ...[...SUBSCRIPTION_PLANS, TEAM_PLAN]
        .filter(plan => plan.priceId)
        .map(plan => ({ value: plan.priceId, label: plan.name })),
      { value: UNKNOWN_PLAN_FILTER, label: 'Unknown plan' },
    ],
    []
  );

  const isShown = (key: SubscriptionsFilterKey) => revealed.has(key) || params[key] !== undefined;
  const hidden = MORE_FILTERS.filter(filter => !isShown(filter.key));
  const update = (patch: Partial<SubscriptionsListParams>) => onChange({ ...patch, page: 1 });

  return (
    <Stack gap={1.25} sx={adminFocusScope} data-testid="admin-subscriptions-toolbar">
      <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
        <AdminSearchInput
          value={search}
          onChange={onSearchChange}
          label="Search name, email, organization or Stripe ID"
          data-testid="admin-subscriptions-search-input"
        />
      </Stack>
      <Stack direction="row" alignItems="center" flexWrap="wrap" gap={0.75} data-testid="admin-subscriptions-filters">
        <FilterChip
          multiple
          id="subscriptions-status"
          label="Status"
          options={STATUS_OPTIONS}
          value={params.status ?? []}
          onChange={values => update({ status: parseStatusList(values) })}
        />
        <FilterChip
          id="subscriptions-source"
          label="Source"
          options={SOURCE_OPTIONS}
          value={params.source}
          onChange={value => update({ source: value as SubscriptionsListParams['source'] })}
        />
        <FilterChip
          multiple
          id="subscriptions-plan"
          label="Plan"
          options={planOptions}
          value={params.plan ?? []}
          onChange={plans => update({ plan: plans.length > 0 ? plans : undefined })}
        />
        {MORE_FILTERS.filter(filter => isShown(filter.key)).map(filter => (
          <FilterChip
            key={filter.key}
            id={`subscriptions-${filter.key}`}
            label={filter.label}
            options={filter.options}
            value={params[filter.key]}
            // The chip's options are this filter's own values, so the key and value stay paired.
            onChange={value => update({ [filter.key]: value } as Partial<SubscriptionsListParams>)}
          />
        ))}
        {hidden.length > 0 && (
          <Dropdown>
            <MenuButton
              size="sm"
              variant="plain"
              startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
              data-testid="admin-subscriptions-add-filter-btn"
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
                  data-testid={`admin-subscriptions-add-filter-${filter.key}`}
                  onClick={() => setRevealed(current => new Set([...current, filter.key]))}
                >
                  {filter.label}
                </MenuItem>
              ))}
            </Menu>
          </Dropdown>
        )}
        {countActiveFilters(params) > 0 && (
          <Button
            size="sm"
            variant="plain"
            data-testid="admin-subscriptions-clear-filters-btn"
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
