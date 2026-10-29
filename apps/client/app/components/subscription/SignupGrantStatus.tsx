import { useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { signupGrantRemaining } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';

export default function SignupGrantStatus() {
  const { currentUser, refreshUser } = useUser();
  const activity = useGetSettingsValue('signupGrantActivityEnabled');
  const organizationInvites = useGetSettingsValue('signupGrantOrgInviteEnabled');
  const activityEnabled = activity === true || activity === 'true';
  const organizationInvitesEnabled = organizationInvites === true || organizationInvites === 'true';
  const eligibilityEnabled = activityEnabled || organizationInvitesEnabled;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const grant = currentUser?.signupGrant;
  if (currentUser?.signupGrantHeldReason === 'budget_exhausted' && (!grant || grant.stage === 'pending_email')) {
    return (
      <Typography level="body-sm" data-testid="signup-grant-status">
        Your free credits are being prepared.
      </Typography>
    );
  }
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
      {remaining > 0 && grant.stage !== 'pending_email' && eligibilityEnabled && (
        <Button
          size="sm"
          variant="outlined"
          loading={busy}
          data-testid="signup-grant-check-btn"
          onClick={async () => {
            setBusy(true);
            setMessage('');
            try {
              const { data } = await api.post<{ creditsGranted: number }>('/api/users/signup-grant-eligibility');
              // The check already committed; a failed refresh only delays the new balance.
              await refreshUser().catch((error: unknown) => console.warn('Failed to refresh user', error));
              setMessage(
                data.creditsGranted > 0
                  ? `${data.creditsGranted.toLocaleString('en-US')} credits unlocked.`
                  : activityEnabled && organizationInvitesEnabled
                    ? 'Not eligible yet. Accept an organization invite or keep using chat on different days, then check again.'
                    : activityEnabled
                      ? 'Not eligible yet. Keep using chat on different days and check again later.'
                      : 'Not eligible yet. An accepted organization invite can unlock the remaining credits.'
              );
            } catch {
              setMessage('Could not check eligibility. Please try again later.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Check grant eligibility
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
