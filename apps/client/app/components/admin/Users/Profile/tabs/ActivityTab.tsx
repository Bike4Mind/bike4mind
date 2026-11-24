import React, { useMemo, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  USER_TIMELINE_CATEGORIES,
  USER_TIMELINE_CATEGORY_LABELS,
  USER_TIMELINE_TYPES,
  API_REQUEST_LOG_COVERAGE,
  type AdminUsageReceiptQuery,
  type AuditEntry,
} from '@bike4mind/common';
import { useUserTimeline } from '@client/app/hooks/data/adminUserTimeline';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import { OptionalDateInput } from '@client/app/components/common/OptionalDateInput';
import { todayUtc } from '@client/app/utils/dateUtils';
import { EmptyState, ErrorState, SectionCard, ToggleChipGroup } from '../../../shared';
import {
  activityFiltersFromSearch,
  activitySearchFromFilters,
  categoriesOfTypes,
  typesOfCategories,
  type ActivityFilters,
  type ActivitySearch,
} from '../activitySearch';
import { TimelineList, TimelineSkeleton } from './TimelineList';
import { timelineItems } from './timelineItems';
import { UsageReceiptDrawer } from './credits/UsageReceiptDrawer';

export const CATEGORY_OPTIONS = USER_TIMELINE_CATEGORIES.map(category => ({
  value: category,
  label: USER_TIMELINE_CATEGORY_LABELS[category],
}));

type ActivityTimelineProps = {
  userId: string;
  filters: ActivityFilters;
  onFiltersChange: (filters: ActivityFilters) => void;
  onOpenCredits?: () => void;
  onOpenApiRequests?: () => void;
};

const isFiltered = (filters: ActivityFilters) =>
  Boolean(filters.from || filters.to) || filters.types.length < USER_TIMELINE_TYPES.length;

/** The merged, newest-first timeline with its source and date filters; the URL owns the filters. */
export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({
  userId,
  filters,
  onFiltersChange,
  onOpenCredits,
  onOpenApiRequests,
}) => {
  const timeline = useUserTimeline(userId, filters);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const [receipt, setReceipt] = useState<AdminUsageReceiptQuery | null>(null);
  const items = useMemo(
    () =>
      timelineItems(timeline.data?.pages.flatMap(page => page.entries) ?? [], {
        onOpenAudit: setSelected,
        onOpenCredits,
        onOpenApiRequests,
        onOpenReceipt: setReceipt,
      }),
    [timeline.data, onOpenCredits, onOpenApiRequests]
  );
  const clear = () => onFiltersChange({ types: [...USER_TIMELINE_TYPES] });

  const body = () => {
    if (timeline.isLoading) return <TimelineSkeleton />;
    if (timeline.isError)
      return <ErrorState message="The activity could not be loaded." onRetry={() => void timeline.refetch()} />;
    if (items.length === 0) {
      return isFiltered(filters) ? (
        <EmptyState
          title="No activity matches these filters"
          description="Widen the date range or include more sources."
          action={
            <Button size="sm" variant="outlined" color="neutral" onClick={clear} data-testid="user-timeline-clear-btn">
              Clear filters
            </Button>
          }
        />
      ) : (
        <EmptyState
          title="No activity yet"
          description="API requests, spend, limits, sign-ins, payments and admin changes appear here."
          action={null}
        />
      );
    }
    return <TimelineList items={items} rowTestId="user-timeline-row" data-testid="user-timeline-list" />;
  };

  return (
    <>
      <SectionCard
        title="Timeline"
        body="custom"
        action={
          <ToggleChipGroup
            options={CATEGORY_OPTIONS}
            value={categoriesOfTypes(filters.types)}
            onChange={categories => onFiltersChange({ ...filters, types: typesOfCategories(categories) })}
            aria-label="Show activity from"
            data-testid="user-timeline-filter-type"
          />
        }
        data-testid="user-profile-activity"
      >
        <Stack
          direction="row"
          flexWrap="wrap"
          gap={1}
          alignItems="center"
          sx={{ px: 2, py: 1, borderBottom: '1px solid', borderColor: 'admin.border' }}
        >
          <OptionalDateInput
            size="sm"
            value={filters.from ?? ''}
            onChange={from => onFiltersChange({ ...filters, from: from || undefined })}
            emptyLabel="From any date"
            setLabel="Set start date"
            clearLabel="Remove start date"
            initialDate={() => (filters.to && filters.to < todayUtc() ? filters.to : todayUtc())}
            max={filters.to}
            aria-label="From"
            testId="user-timeline-filter-from"
          />
          <OptionalDateInput
            size="sm"
            value={filters.to ?? ''}
            onChange={to => onFiltersChange({ ...filters, to: to || undefined })}
            emptyLabel="To any date"
            setLabel="Set end date"
            clearLabel="Remove end date"
            initialDate={() => (filters.from && filters.from > todayUtc() ? filters.from : todayUtc())}
            min={filters.from}
            aria-label="To"
            testId="user-timeline-filter-to"
          />
          {(filters.from || filters.to) && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => onFiltersChange({ types: filters.types })}
              data-testid="user-timeline-clear-dates-btn"
            >
              Clear dates
            </Button>
          )}
        </Stack>
        {body()}
        {filters.types.includes('api_request') && (
          <Typography
            level="body-xs"
            sx={{ px: 2, py: 1.5, color: 'admin.inkMuted' }}
            data-testid="user-timeline-api-coverage"
          >
            {API_REQUEST_LOG_COVERAGE}
          </Typography>
        )}
        {timeline.hasNextPage && (
          <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'admin.border' }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={timeline.isFetchingNextPage}
              onClick={() => void timeline.fetchNextPage()}
              data-testid="user-timeline-load-more-btn"
            >
              Load more
            </Button>
          </Box>
        )}
      </SectionCard>
      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
      <UsageReceiptDrawer userId={userId} target={receipt} onClose={() => setReceipt(null)} />
    </>
  );
};

/** Activity bound to the profile URL: `?tab=activity&types=...&from=...&to=...`. */
export const ActivityTab: React.FC<{ userId: string; onOpenCredits?: () => void }> = ({ userId, onOpenCredits }) => {
  const search: ActivitySearch = useSearch({ from: '/admin-layout/admin/users/$userId' });
  const navigate = useNavigate({ from: '/admin/users/$userId' });
  const filters = activityFiltersFromSearch(search);
  // Replace, like the tab switch: each chip click is not a history entry worth walking back through.
  const setFilters = (next: ActivityFilters) =>
    void navigate({ search: previous => ({ ...previous, ...activitySearchFromFilters(next) }), replace: true });
  return (
    <ActivityTimeline
      userId={userId}
      filters={filters}
      onFiltersChange={setFilters}
      onOpenCredits={onOpenCredits}
      onOpenApiRequests={() =>
        void navigate({
          search: previous => ({ ...previous, tab: 'keys', types: undefined, from: undefined, to: undefined }),
          replace: true,
        })
      }
    />
  );
};
