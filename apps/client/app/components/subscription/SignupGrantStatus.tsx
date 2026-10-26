import { useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { signupGrantRemaining } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';

export default function SignupGrantStatus() {
  const { currentUser, refreshUser } = useUser();
  const activity = useGetSettingsValue('signupGrantActivityEnabled');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const grant = currentUser?.signupGrant;
  if (!grant) return null;
  const remaining = signupGrantRemaining(grant);
  return (
    <Stack spacing={1} data-testid="signup-grant-status">
      <Typography level="body-sm">
        {grant.creditsReleased.toLocaleString('en-US')} signup credits released.
        {remaining > 0
          ? ` Up to ${remaining.toLocaleString('en-US')} more credits can be earned after eligibility checks.`
          : ' Your signup grant is fully released.'}
        {grant.stage === 'pending_email' && ' Verify your email to release your signup tranche.'}
      </Typography>
      {remaining > 0 && grant.stage !== 'pending_email' && (activity === true || activity === 'true') && (
        <Button
          size="sm"
          variant="outlined"
          loading={busy}
          data-testid="signup-grant-check-btn"
          onClick={async () => {
            setBusy(true);
            setMessage('');
            try {
              const { data } = await api.post<{ creditsGranted: number }>('/api/users/signup-grant-activity');
              await refreshUser();
              setMessage(
                data.creditsGranted > 0
                  ? `${data.creditsGranted.toLocaleString('en-US')} credits unlocked.`
                  : 'Not eligible yet. Keep using chat on different days and check again later.'
              );
            } catch {
              setMessage('Could not check eligibility. Please try again later.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Check activity eligibility
        </Button>
      )}
      {message && (
        <Typography role="status" level="body-sm" data-testid="signup-grant-result">
          {message}
        </Typography>
      )}
    </Stack>
  );
}
