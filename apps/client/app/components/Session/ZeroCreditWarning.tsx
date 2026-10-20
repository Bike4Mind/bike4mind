import { useState } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useGearsNavSignal } from '@client/app/hooks/useVisibleGears';
import {
  isAwaitingEmailVerification,
  resendVerificationErrorMessage,
  type ResendVerificationError,
} from '@client/app/utils/onboarding';
import { CreditsWarning } from './SessionWarnings';
import { zeroCreditReason } from './zeroCreditModel';

function ResendVerificationButton() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: async () => (await api.post('/api/email/resend-verification')).data,
    onMutate: () => setErrorMessage(null),
    onError: (error: ResendVerificationError) => setErrorMessage(resendVerificationErrorMessage(error)),
  });

  return (
    <Box>
      <Button
        size="sm"
        variant="soft"
        onClick={() => resend.mutate()}
        loading={resend.isPending}
        disabled={resend.isSuccess}
        data-testid="credits-warning-verify-btn"
      >
        {resend.isSuccess
          ? 'Verification email sent'
          : errorMessage
            ? "Couldn't send. Try again"
            : 'Resend verification email'}
      </Button>
      {errorMessage && (
        <Typography
          level="body-xs"
          color="danger"
          data-testid="credits-warning-verify-error"
          sx={{ mt: '4px', maxWidth: '420px' }}
        >
          {errorMessage}
        </Typography>
      )}
    </Box>
  );
}

/** A personal account's free routes. Only mounted for one, so an organization never queries Gears. */
function PersonalZeroCreditWarning({ hasDraft }: { hasDraft: boolean }) {
  const navigate = useNavigate();
  const awaitingVerification = useUser(s => isAwaitingEmailVerification(s.currentUser));
  const { claimableCount } = useGearsNavSignal();
  const showGears = claimableCount > 0;

  return (
    <CreditsWarning
      show
      hasDraft={hasDraft}
      reason={zeroCreditReason({ awaitingVerification, personal: true })}
      freeRoutes={
        awaitingVerification || showGears ? (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
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
            {awaitingVerification && <ResendVerificationButton />}
          </Box>
        ) : undefined
      }
    />
  );
}

/**
 * The out-of-credits block with what this account can actually do for free: claim a Gears reward,
 * or finish the email verification that releases the starter grant. Free routes belong to the
 * personal account, so an organization's empty balance gets only the paid offer.
 */
export function ZeroCreditWarning({ hasDraft }: { hasDraft: boolean }) {
  const isPersonal = useSelectedAccount(s => !s.selectedAccount || s.selectedAccount.personal);

  if (!isPersonal) {
    return (
      <CreditsWarning
        show
        hasDraft={hasDraft}
        reason={zeroCreditReason({ awaitingVerification: false, personal: false })}
      />
    );
  }
  return <PersonalZeroCreditWarning hasDraft={hasDraft} />;
}
