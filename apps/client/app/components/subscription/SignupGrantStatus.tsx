import { Stack, Typography } from '@mui/joy';
import { signupGrantRemaining } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useSignupGrantSchedule } from '@client/app/hooks/useSignupGrantSchedule';
import { advertisedDripCredits, unlockPathsCopy } from '@client/app/components/Session/newUserWelcomeModel';

export default function SignupGrantStatus() {
  const { currentUser } = useUser();
  const { dailyCredits, dripCap } = useSignupGrantSchedule();
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
      {remaining > 0 && (
        <Typography level="body-sm" data-testid="signup-grant-unlock-paths">
          {unlockPathsCopy(advertisedDripCredits({ dailyCredits, dripCap, grant }), minActiveSeconds)}
        </Typography>
      )}
    </Stack>
  );
}
