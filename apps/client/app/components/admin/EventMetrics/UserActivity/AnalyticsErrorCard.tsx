import React from 'react';
import { Box } from '@mui/joy';
import { ErrorState } from '../../shared';

interface AnalyticsErrorCardProps {
  error: unknown;
  onRetry: () => void;
  title?: string;
  testId?: string;
}

/**
 * A failed analytics request must not look like an empty one: the User Activity endpoint
 * returned 502 for weeks while the UI showed "No data found", because the fetch helper
 * turned errors into an empty array. ErrorState's role="alert" announces the swap.
 */
export const AnalyticsErrorCard: React.FC<AnalyticsErrorCardProps> = ({
  error,
  onRetry,
  title = 'Could not load analytics',
  testId = 'analytics-error',
}) => (
  <Box data-testid={testId}>
    <ErrorState
      message={`${title}: ${error instanceof Error ? error.message : 'The request failed.'}`}
      onRetry={onRetry}
    />
  </Box>
);
