import { Alert, Box, Button, LinearProgress, Sheet, Stack, Typography } from '@mui/joy';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { adminSurface } from '../shared/adminStyles';
import { SignupChart } from './SignupChart';
import { useSignupTimeseries } from './useSignupTimeseries';

/**
 * Overview tile for the last 30 days of signups. The headline is the likely-legit count, so a bot
 * farm cannot inflate the number marketing reads; suspected signups are reported beside it.
 */
export function NewSignupsTile({ onReview }: { onReview: () => void }) {
  const query = useSignupTimeseries('30d');
  const totals = query.data?.totals;

  return (
    <Sheet variant="outlined" sx={{ ...adminSurface, p: 2 }} data-testid="admin-dashboard-signups-tile">
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2}>
        <Box sx={{ minWidth: 200 }}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            New signups, last 30 days
          </Typography>
          <Typography
            level="h2"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
            data-testid="admin-dashboard-signups-legit"
          >
            {totals ? totals.likelyLegit.toLocaleString() : '-'}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
            likely legit
          </Typography>
          {totals && (
            <Typography
              level="body-xs"
              sx={{ color: 'admin.inkMuted', mt: 1 }}
              data-testid="admin-dashboard-signups-suspected"
            >
              {totals.suspected.toLocaleString()} suspected not counted
              {totals.unclassified > 0 && `, ${totals.unclassified.toLocaleString()} not classified`}
            </Typography>
          )}
          <Button
            variant="plain"
            size="sm"
            endDecorator={<ArrowForwardIcon />}
            onClick={onReview}
            sx={{ mt: 1, px: 0 }}
            data-testid="admin-dashboard-signups-review-btn"
          >
            Review signups
          </Button>
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {query.isLoading && <LinearProgress aria-label="Loading signups" />}
          {query.isError && (
            <Alert color="danger" size="sm">
              Signups could not be loaded. Open Users to retry.
            </Alert>
          )}
          {query.data && <SignupChart data={query.data} height={140} testId="admin-dashboard-signups-chart" />}
        </Box>
      </Stack>
    </Sheet>
  );
}
