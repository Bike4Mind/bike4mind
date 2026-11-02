import { Stack, Typography } from '@mui/joy';
import { signupGrantRemaining } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { advertisedDripCredits, unlockPathsCopy } from '@client/app/components/Session/newUserWelcomeModel';

const formatUnlockDate = (date: Date | string) =>
  new Date(date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function SignupGrantStatus() {
  const { currentUser } = useUser();
  const activity = useGetSettingsValue('signupGrantActivityEnabled');
  const dailyCredits = Number(useGetSettingsValue('signupGrantActivityDailyCredits')) || 0;
  const minActiveSeconds = useGetSettingsValue('signupGrantActivityMinActiveSeconds');
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
      <Typography level="body-sm" data-testid="signup-grant-released">
        {grant.creditsReleased.toLocaleString('en-US')} signup credits released.
        {remaining > 0
          ? ` ${remaining.toLocaleString('en-US')} more credits are still locked.`
          : ' Your signup grant is fully released.'}
        {grant.stage === 'pending_email' && ' Verify your email to release your signup tranche.'}
      </Typography>
      {remaining > 0 && grant.heldUnlock && (
        <Typography level="body-sm" data-testid="signup-grant-held-unlock">
          Your payment unlocked your bonus credits. They unlock on {formatUnlockDate(grant.heldUnlock.releaseAt)}, once
          the payment has settled.
        </Typography>
      )}
      {remaining > 0 && !grant.heldUnlock && (
        <Typography level="body-sm" data-testid="signup-grant-unlock-paths">
          {unlockPathsCopy(
            advertisedDripCredits({ enabled: activity, dailyCredits, unlockCredits: grant.unlockCredits }),
            minActiveSeconds
          )}
        </Typography>
      )}
    </Stack>
  );
}
