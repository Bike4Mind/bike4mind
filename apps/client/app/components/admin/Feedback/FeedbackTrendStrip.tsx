import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import { getFeedbackTrendsFromServer } from '@client/app/utils/feedbackAPICalls';
import { adminChartSeries } from '../EventMetrics/utils/chartTheme';
import { Dash, StatStrip, StatTile } from '../shared';
import { FEEDBACK_STATUS_ORDER, FEEDBACK_TYPE_LABELS, FEEDBACK_TYPE_ORDER } from './constants';
import { toStatusFilters } from './feedbackTabSearch';
import {
  emptyFeedbackTypeCounts,
  FEEDBACK_TREND_DAYS,
  sumFeedbackTypeCounts,
  thumbsDownPercent,
  type FeedbackTrends,
  type FeedbackTypeCounts,
} from './feedbackTrends';
import { FEEDBACK_TRENDS_QUERY_KEY } from './queryKeys';
import type { UseFeedbackFiltersReturn } from './types';

type ShowOnly = UseFeedbackFiltersReturn['showOnly'];

const ALL_STATUSES = toStatusFilters(FEEDBACK_STATUS_ORDER);
const OPEN_STATUSES = toStatusFilters([FeedbackStatus.New, FeedbackStatus.InProgress]);
const SERIES_COLORS = adminChartSeries(FEEDBACK_TYPE_ORDER.length);

const resetButton = {
  appearance: 'none',
  border: 0,
  m: 0,
  p: 0,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  bgcolor: 'transparent',
  cursor: 'pointer',
} as const;

/**
 * A stat tile that applies the filter it counts. The button overlays the tile rather than wrapping
 * it, since a button may not contain the tile's block elements, and the plain wrapper is what keeps
 * StatStrip's dividers.
 */
const FigureButton = ({
  label,
  onClick,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) => (
  <Box data-testid={testId} sx={{ position: 'relative', minWidth: 0, '&:hover': { bgcolor: 'admin.hover' } }}>
    {children}
    <Box
      component="button"
      type="button"
      aria-label={label}
      onClick={onClick}
      data-testid={`${testId}-btn`}
      sx={{ ...resetButton, position: 'absolute', inset: 0, width: '100%' }}
    />
  </Box>
);

/** 30 stacked day bars, one segment per type, oldest on the left. */
const TypeSparkline = ({ daily, total }: { daily: readonly FeedbackTypeCounts[]; total: FeedbackTypeCounts }) => {
  const max = Math.max(...daily.map(sumFeedbackTypeCounts), 0);
  const summary = FEEDBACK_TYPE_ORDER.map(type => `${FEEDBACK_TYPE_LABELS[type]} ${total[type]}`).join(', ');
  return (
    <Box
      role="img"
      aria-label={`Reports per day over the last ${FEEDBACK_TREND_DAYS} days by type: ${summary}`}
      data-testid="feedback-trends-sparkline"
      sx={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: 28 }}
    >
      {daily.map((day, index) => {
        const dayTotal = sumFeedbackTypeCounts(day);
        return (
          <Box
            key={index}
            sx={{
              flex: 1,
              height: max > 0 && dayTotal > 0 ? `${Math.max(8, (dayTotal / max) * 100)}%` : '2px',
              display: 'flex',
              flexDirection: 'column-reverse',
              borderRadius: '2px',
              overflow: 'hidden',
              bgcolor: dayTotal === 0 ? 'admin.border' : undefined,
            }}
          >
            {FEEDBACK_TYPE_ORDER.map((type, typeIndex) =>
              day[type] > 0 ? (
                <Box key={type} sx={{ flexGrow: day[type], flexBasis: 0, bgcolor: SERIES_COLORS[typeIndex] }} />
              ) : null
            )}
          </Box>
        );
      })}
    </Box>
  );
};

const TypeLegend = ({
  total,
  untyped,
  showOnly,
}: {
  total: FeedbackTypeCounts;
  /** Reports in the 30-day total whose legacy type no legend entry counts. */
  untyped: number;
  showOnly: ShowOnly;
}) => (
  <Stack direction="row" flexWrap="wrap" columnGap={1.25} rowGap={0.25} component="span">
    {FEEDBACK_TYPE_ORDER.map((type, typeIndex) => {
      const count = total[type];
      return (
        <Box
          key={type}
          component="button"
          type="button"
          onClick={() => showOnly({ statusFilters: ALL_STATUSES, types: [type], received: '30d' })}
          aria-label={`Show ${FEEDBACK_TYPE_LABELS[type].toLowerCase()} reports from the last ${FEEDBACK_TREND_DAYS} days (${count.toLocaleString()})`}
          data-testid={`feedback-trends-type-${type}`}
          sx={{
            ...resetButton,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            borderRadius: 'xs',
            '&:hover': { color: 'admin.ink', textDecoration: 'underline' },
          }}
        >
          <Box component="span" sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: SERIES_COLORS[typeIndex] }} />
          {FEEDBACK_TYPE_LABELS[type]} {count.toLocaleString()}
        </Box>
      );
    })}
    {untyped > 0 && (
      <Box
        component="span"
        title="Reports with an older type that has no series"
        data-testid="feedback-trends-type-other"
      >
        Other type {untyped.toLocaleString()}
      </Box>
    )}
  </Stack>
);

const shareComparison = ({ thumbsDownShare }: FeedbackTrends): string => {
  const prior = thumbsDownPercent(thumbsDownShare.prior);
  if (prior === undefined) return 'No reports in the 7 days before';
  const current = thumbsDownPercent(thumbsDownShare.current);
  if (current === undefined) return `${prior}% the 7 days before`;
  const change = current - prior;
  const direction = change === 0 ? 'no change' : `${change > 0 ? 'up' : 'down'} ${Math.abs(change)} pts`;
  return `${prior}% the 7 days before, ${direction}`;
};

/**
 * Open, last-24-hour, thumbs-down-share and 30-day counts above the feedback table. Each figure is a
 * button that resets the table's filters to exactly the reports it counts.
 */
export default function FeedbackTrendStrip({ showOnly }: { showOnly: ShowOnly }) {
  const { data, isError } = useQuery({
    queryKey: FEEDBACK_TRENDS_QUERY_KEY,
    queryFn: getFeedbackTrendsFromServer,
    staleTime: 60_000,
  });

  const unavailable = <Dash title={isError ? 'Could not load' : 'Loading'} />;
  const currentShare = data ? thumbsDownPercent(data.thumbsDownShare.current) : undefined;
  const daily = data?.daily ?? [];
  const typeTotals = emptyFeedbackTypeCounts();
  for (const day of daily) for (const type of FEEDBACK_TYPE_ORDER) typeTotals[type] += day[type];
  const untyped = data ? Math.max(0, data.receivedLast30d - sumFeedbackTypeCounts(typeTotals)) : 0;
  const withCount = (label: string, count: string | number | undefined) =>
    count === undefined ? label : `${label} (${count.toLocaleString()})`;

  const queryClient = useQueryClient();
  // Refetched with the list, so the figure clicked and the rows it opens are counted moments apart.
  const apply: ShowOnly = view => {
    showOnly(view);
    void queryClient.invalidateQueries({ queryKey: FEEDBACK_TRENDS_QUERY_KEY });
  };

  return (
    <Box data-testid="feedback-trends-strip">
      <StatStrip aria-label="Feedback volume">
        <FigureButton
          label={withCount('Show open reports', data?.open)}
          testId="feedback-trends-open"
          onClick={() => apply({ statusFilters: OPEN_STATUSES })}
        >
          <StatTile label="Open" value={data ? data.open : unavailable} comparison="New and in progress" />
        </FigureButton>
        <FigureButton
          label={withCount('Show reports received in the last 24 hours', data?.receivedLast24h)}
          testId="feedback-trends-received-24h"
          onClick={() => apply({ statusFilters: ALL_STATUSES, received: '24h' })}
        >
          <StatTile
            label="New in the last 24 h"
            value={data ? data.receivedLast24h : unavailable}
            comparison="Any status"
          />
        </FigureButton>
        <FigureButton
          label={withCount(
            'Show thumbs-down reports from the last 7 days',
            currentShare === undefined ? undefined : `${currentShare}%`
          )}
          testId="feedback-trends-thumbs-down"
          onClick={() => apply({ statusFilters: ALL_STATUSES, types: [FeedbackType.THUMBS_DOWN], received: '7d' })}
        >
          <StatTile
            label="Thumbs-down share, 7 days"
            value={data ? currentShare === undefined ? <Dash title="No reports" /> : `${currentShare}%` : unavailable}
            comparison={data ? shareComparison(data) : undefined}
          />
        </FigureButton>
        <Box data-testid="feedback-trends-30d">
          <StatTile
            label={`Last ${FEEDBACK_TREND_DAYS} days by type`}
            value={
              data ? (
                <Box
                  component="button"
                  type="button"
                  onClick={() => apply({ statusFilters: ALL_STATUSES, received: '30d' })}
                  aria-label={withCount(
                    `Show every report from the last ${FEEDBACK_TREND_DAYS} days`,
                    data.receivedLast30d
                  )}
                  data-testid="feedback-trends-received-30d"
                  sx={{ ...resetButton, borderRadius: 'xs', '&:hover': { textDecoration: 'underline' } }}
                >
                  {data.receivedLast30d.toLocaleString()}
                </Box>
              ) : (
                unavailable
              )
            }
            sparkline={data ? <TypeSparkline daily={daily} total={typeTotals} /> : undefined}
            comparison={data ? <TypeLegend total={typeTotals} untyped={untyped} showOnly={apply} /> : undefined}
          />
        </Box>
      </StatStrip>
      {isError && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mt: 0.5 }} data-testid="feedback-trends-error">
          Could not load the feedback trends. Refresh to try again.
        </Typography>
      )}
    </Box>
  );
}
