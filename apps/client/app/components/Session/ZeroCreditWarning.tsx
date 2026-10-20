import { useState } from 'react';
import { Box, Button } from '@mui/joy';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useGearsNavSignal } from '@client/app/hooks/useVisibleGears';
import { CreditsWarning } from './SessionWarnings';
import { isAwaitingEmailVerification } from '@client/app/utils/onboarding';
import { zeroCreditReason } from './zeroCreditModel';

function ResendVerificationButton() {
  const [failed, setFailed] = useState(false);
  const resend = useMutation({
    mutationFn: async () => (await api.post('/api/email/resend-verification')).data,
    onMutate: () => setFailed(false),
    onError: () => setFailed(true),
  });

  return (
    <Button
      size="sm"
      variant="soft"
      onClick={() => resend.mutate()}
      loading={resend.isPending}
      disabled={resend.isSuccess}
      data-testid="credits-warning-verify-btn"
    >
      {resend.isSuccess ? 'Verification email sent' : failed ? "Couldn't send. Try again" : 'Resend verification email'}
    </Button>
  );
}

/**
 * The out-of-credits block with what this account can actually do for free: claim a Gears reward,
 * or finish the email verification that releases the starter grant. Free routes belong to the
 * personal account, so an organization's empty balance gets only the paid offer.
 */
export function ZeroCreditWarning({ hasDraft }: { hasDraft: boolean }) {
  const navigate = useNavigate();
  const isPersonal = useSelectedAccount(s => !s.selectedAccount || s.selectedAccount.personal);
  const awaitingVerification = useUser(s => isAwaitingEmailVerification(s.currentUser));
  const { claimableCount } = useGearsNavSignal();

  const showVerify = isPersonal && awaitingVerification;
  const showGears = isPersonal && claimableCount > 0;

  return (
    <CreditsWarning
      show
      hasDraft={hasDraft}
      reason={zeroCreditReason({ awaitingVerification: showVerify, personal: isPersonal })}
      freeRoutes={
        showVerify || showGears ? (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {showGears && (
              <Button
                size="sm"
                variant="soft"
                onClick={() => navigate({ to: '/gears' })}
                data-testid="credits-warning-gears-btn"
              >
                Claim free credits in Gears
              </Button>
            )}
            {showVerify && <ResendVerificationButton />}
          </Box>
        ) : undefined
      }
    />
  );
}
