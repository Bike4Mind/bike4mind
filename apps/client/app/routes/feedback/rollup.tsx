/**
 * Personal feedback rollup (`/feedback/rollup`).
 *
 * Counts only. The page renders how many reports the signed-in user filed in a date window, broken
 * out by session, quest, subject, status and tag - it never reads a report's free text, so it must
 * not be described (here or in copy) as a summary of what was reported.
 *
 * The window arrives already resolved from the route's `validateSearch`; nothing here computes a
 * date, because a default computed in render would churn the query key on every pass.
 */

import { FC } from 'react';
import { Alert, Box, Card, CircularProgress, Stack, Typography } from '@mui/joy';
import FeedbackOutlinedIcon from '@mui/icons-material/FeedbackOutlined';
import type { FeedbackRollupDimension, FeedbackRollupResponse } from '@bike4mind/common';
import { feedbackRollupRoute } from '@client/app/router';
import { getAxiosErrorStatus } from '@client/app/contexts/ApiContext';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useFeedbackRollup } from '@client/app/hooks/data/feedback';

type DimensionKey = keyof FeedbackRollupResponse['buckets'];

const DIMENSIONS: ReadonlyArray<{ key: DimensionKey; label: string }> = [
  { key: 'subject', label: 'Subject' },
  { key: 'status', label: 'Status' },
  { key: 'tags', label: 'Tags' },
  { key: 'sessionId', label: 'Session' },
  { key: 'questId', label: 'Quest' },
];

/** Dimensions whose keys are raw ids with no name available on this read. */
const OPAQUE_ID_DIMENSIONS: ReadonlySet<DimensionKey> = new Set<DimensionKey>(['sessionId', 'questId']);

/**
 * A bucket key as it should read on screen. Subject, status and tags are already words; a session
 * or quest key is an id, and this view has no lookup for its title, so it is shortened rather than
 * dressed up as a name. The full id stays in the element's `title` for anyone who needs it.
 */
export function rollupBucketLabel(dimension: DimensionKey, key: string): string {
  if (!OPAQUE_ID_DIMENSIONS.has(dimension) || key.length <= 8) return key;
  return `...${key.slice(-6)}`;
}

const formatBound = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 10);
};

const DimensionCard: FC<{ dimension: DimensionKey; label: string; data: FeedbackRollupDimension; topN: number }> = ({
  dimension,
  label,
  data,
  topN,
}) => (
  <Card variant="outlined" sx={{ flex: '1 1 260px', minWidth: 240, gap: 1 }} data-testid={`rollup-${dimension}-card`}>
    <Typography level="title-md">{label}</Typography>

    {data.buckets.length === 0 ? (
      <Typography level="body-sm" textColor="text.tertiary" data-testid={`rollup-${dimension}-empty`}>
        Nothing grouped under {label.toLowerCase()} in this window.
      </Typography>
    ) : (
      <Stack spacing={0.5}>
        {data.buckets.map(bucket => (
          <Stack
            key={bucket.key}
            direction="row"
            justifyContent="space-between"
            spacing={2}
            data-testid={`rollup-${dimension}-row`}
          >
            <Typography level="body-sm" noWrap title={bucket.key}>
              {rollupBucketLabel(dimension, bucket.key)}
            </Typography>
            <Typography level="body-sm" fontWeight="lg">
              {bucket.count}
            </Typography>
          </Stack>
        ))}
      </Stack>
    )}

    {data.truncated && (
      <Typography level="body-xs" textColor="text.tertiary" data-testid={`rollup-${dimension}-truncated`}>
        Showing the top {topN} by count; the rest are not listed.
      </Typography>
    )}
  </Card>
);

const FeedbackRollupPage: FC = () => {
  useDocumentTitle('Your feedback');

  const { from, to } = feedbackRollupRoute.useSearch();
  const { data, isPending, isError, error } = useFeedbackRollup({ from, to });

  if (isPending) {
    return (
      <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }} data-testid="rollup-loading-indicator">
        <CircularProgress />
      </Box>
    );
  }

  if (isError) {
    // The route validates its window with zod, and this app's error handler maps every ZodError
    // onto 422 - not the 400 a rejected query might otherwise suggest.
    const invalidWindow = getAxiosErrorStatus(error) === 422;
    return (
      <Box sx={{ p: 3 }}>
        <Alert color="danger" variant="soft" data-testid="rollup-error-alert">
          {invalidWindow
            ? 'That date range is not valid. Pick a start before the end, within the allowed window length.'
            : 'We could not load your feedback counts. Please try again.'}
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, maxWidth: 1100, mx: 'auto', width: '100%' }} data-testid="rollup-page-root">
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 0.5 }}>
        <FeedbackOutlinedIcon />
        <Typography level="h2">Your feedback</Typography>
      </Stack>
      <Typography level="body-sm" textColor="text.secondary">
        {data.total} {data.total === 1 ? 'report' : 'reports'} between {formatBound(data.from)} and{' '}
        {formatBound(data.to)}. Counts only - this page does not show what any report said.
      </Typography>

      {data.textAvailability.expired > 0 && (
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 1 }} data-testid="rollup-retention-notice">
          {data.textAvailability.expired} of these reports are past the {data.textRetentionDays}-day text retention
          window, so their wording has been removed. The counts here are unaffected.
        </Typography>
      )}

      {data.total === 0 ? (
        <Card variant="soft" sx={{ mt: 3 }} data-testid="rollup-empty-state">
          <Typography level="title-md">No feedback in this window</Typography>
          <Typography level="body-sm" textColor="text.secondary">
            Nothing you filed falls between these dates. Try a wider range.
          </Typography>
        </Card>
      ) : (
        <Stack direction="row" flexWrap="wrap" spacing={0} useFlexGap gap={2} sx={{ mt: 3 }}>
          {DIMENSIONS.map(({ key, label }) => (
            <DimensionCard key={key} dimension={key} label={label} data={data.buckets[key]} topN={data.topN} />
          ))}
        </Stack>
      )}
    </Box>
  );
};

export default FeedbackRollupPage;
