import { Alert, Button, Stack, Typography } from '@mui/joy';
import type { SignupAnomalySnapshot } from '@client/app/utils/signupAnomaly';

export function AnomalyBanner({ snapshot, onReview }: { snapshot?: SignupAnomalySnapshot; onReview: () => void }) {
  if (!snapshot || (!snapshot.signupSpike && !snapshot.apiKeySpike && !snapshot.truncated)) return null;
  return (
    <Alert color="warning" data-testid="users-anomaly-banner">
      <Stack gap={1}>
        <Typography>Review signup activity in the last hour</Typography>
        <Typography level="body-sm">
          {snapshot.signupCount.toLocaleString()} signups, {snapshot.apiKeyCount.toLocaleString()} new API keys. Top
          signup domain: {snapshot.topDomain ?? 'None'}.
          {snapshot.truncated && ' Scan limit reached; counts and domain ranking are partial.'}
        </Typography>
        <Button variant="outlined" color="warning" data-testid="users-review-cluster-btn" onClick={onReview}>
          Review cluster
        </Button>
      </Stack>
    </Alert>
  );
}
