import { useState, type ReactNode } from 'react';
import { Box, Button, Skeleton, Stack, Typography } from '@mui/joy';
import { EmptyState, ErrorState, SectionCard } from '../shared';

type AnalyticsSectionProps = {
  title: string;
  /** One line under the title: the takeaway, with the time unit (UTC). */
  caption?: string;
  /** Controls beside "View as table" in the title bar. */
  action?: ReactNode;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  empty: boolean;
  onShowDefaultRange?: () => void;
  chart: ReactNode;
  table: ReactNode;
  /** Below the chart or table, e.g. the signal rows. */
  footer?: ReactNode;
  testId: string;
};

/** A SectionCard holding one chart, with its own loading, error, empty and table states (spec 4.9, 4.11). */
export function AnalyticsSection({
  title,
  caption,
  action,
  loading,
  error,
  onRetry,
  empty,
  onShowDefaultRange,
  chart,
  table,
  footer,
  testId,
}: AnalyticsSectionProps) {
  const [asTable, setAsTable] = useState(false);
  const ready = !loading && !error && !empty;

  let body: ReactNode;
  if (loading) {
    body = (
      <Skeleton variant="rectangular" height={240} data-testid={`${testId}-skeleton`} sx={{ borderRadius: 'md' }} />
    );
  } else if (error) {
    body = <ErrorState message={`Could not load ${title.toLowerCase()}.`} onRetry={onRetry} />;
  } else if (empty) {
    body = (
      <EmptyState
        title="No activity in this range"
        action={
          onShowDefaultRange ? (
            <Button variant="outlined" onClick={onShowDefaultRange} data-testid={`${testId}-show-90d-btn`}>
              Show last 90 days
            </Button>
          ) : null
        }
      />
    );
  } else {
    body = asTable ? table : chart;
  }

  return (
    <SectionCard
      title={title}
      body="custom"
      data-testid={testId}
      action={
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          {action}
          {ready && (
            <Button
              size="sm"
              variant="plain"
              aria-pressed={asTable}
              onClick={() => setAsTable(value => !value)}
              data-testid={`${testId}-table-toggle-btn`}
            >
              {asTable ? 'View as chart' : 'View as table'}
            </Button>
          )}
        </Stack>
      }
    >
      <Box sx={{ px: 2, py: 1.75, minWidth: 0 }}>
        {caption && ready && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mb: 1.5 }} data-testid={`${testId}-caption`}>
            {caption}
          </Typography>
        )}
        {body}
        {ready && footer}
      </Box>
    </SectionCard>
  );
}
