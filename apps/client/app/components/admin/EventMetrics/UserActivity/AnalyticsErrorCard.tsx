import React from 'react';
import { Button, Card, Stack, Typography } from '@mui/joy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RefreshIcon from '@mui/icons-material/Refresh';

interface AnalyticsErrorCardProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  testId?: string;
}

/**
 * A failed analytics request must not look like an empty one: the User Activity endpoint
 * returned 502 for weeks while the UI showed "No data found", because the fetch helper
 * turned every error into an empty array.
 */
export const AnalyticsErrorCard: React.FC<AnalyticsErrorCardProps> = ({
  error,
  onRetry,
  title = 'Could not load analytics',
  testId = 'analytics-error',
}) => (
  <Card
    variant="outlined"
    // The whole point of this card is that a failure does not read as an empty result. A screen
    // reader gets that only from the live region: the tab swaps content in place, no focus move.
    role="alert"
    aria-live="assertive"
    sx={{ p: 4, textAlign: 'center' }}
    data-testid={testId}
  >
    <Stack alignItems="center" spacing={2}>
      <ErrorOutlineIcon sx={{ fontSize: 48, color: 'danger.500' }} />
      <Typography level="body-lg">{title}</Typography>
      <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
        {error instanceof Error ? error.message : 'The request failed.'}
      </Typography>
      {onRetry && (
        <Button size="sm" startDecorator={<RefreshIcon />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </Stack>
  </Card>
);
