import React, { useMemo, useState } from 'react';
import { Box, Button, Input, Stack, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { USER_TIMELINE_TYPES, type AuditEntry } from '@bike4mind/common';
import { useUserTimeline } from '@client/app/hooks/data/adminUserTimeline';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import { EmptyState, ErrorState, SectionCard, ToggleChipGroup } from '../../../shared';
import {
  activityFiltersFromSearch,
  activitySearchFromFilters,
  type ActivityFilters,
  type ActivitySearch,
} from '../activitySearch';
import { TimelineList, TimelineSkeleton } from './TimelineList';
import { TIMELINE_TYPE_LABELS, timelineItem } from './timelineItems';

const TYPE_OPTIONS = USER_TIMELINE_TYPES.map(type => ({ value: type, label: TIMELINE_TYPE_LABELS[type] }));

type ActivityTimelineProps = {
  userId: string;
  filters: ActivityFilters;
  onFiltersChange: (filters: ActivityFilters) => void;
  onOpenCredits?: () => void;
};

const isFiltered = (filters: ActivityFilters) =>
  Boolean(filters.from || filters.to) || filters.types.length < USER_TIMELINE_TYPES.length;

/** The merged, newest-first timeline with its source and date filters; the URL owns the filters. */
export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({
  userId,
  filters,
  onFiltersChange,
  onOpenCredits,
}) => {
  const timeline = useUserTimeline(userId, filters);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const items = useMemo(
    () =>
      (timeline.data?.pages.flatMap(page => page.entries) ?? []).map(entry =>
        timelineItem(entry, { onOpenAudit: setSelected, onOpenCredits })
      ),
    [timeline.data, onOpenCredits]
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
          description="Sign-ins, usage, credits and admin changes appear here."
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
            options={TYPE_OPTIONS}
            value={filters.types}
            onChange={types => onFiltersChange({ ...filters, types })}
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
          <Typography component="label" level="body-xs" htmlFor="user-timeline-from" sx={{ color: 'admin.inkMuted' }}>
            From
          </Typography>
          <Input
            size="sm"
            type="date"
            value={filters.from ?? ''}
            onChange={event => onFiltersChange({ ...filters, from: event.target.value || undefined })}
            slotProps={{ input: { id: 'user-timeline-from', max: filters.to } }}
            data-testid="user-timeline-filter-from"
          />
          <Typography component="label" level="body-xs" htmlFor="user-timeline-to" sx={{ color: 'admin.inkMuted' }}>
            To
          </Typography>
          <Input
            size="sm"
            type="date"
            value={filters.to ?? ''}
            onChange={event => onFiltersChange({ ...filters, to: event.target.value || undefined })}
            slotProps={{ input: { id: 'user-timeline-to', min: filters.from } }}
            data-testid="user-timeline-filter-to"
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
    <ActivityTimeline userId={userId} filters={filters} onFiltersChange={setFilters} onOpenCredits={onOpenCredits} />
  );
};
