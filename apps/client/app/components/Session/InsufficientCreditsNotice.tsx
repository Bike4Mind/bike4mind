import { Alert, Box, Typography } from '@mui/joy';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { SubscribeButton, SessionCreditsButton } from './SessionCreditsButtons';

interface InsufficientCreditsNoticeProps {
  /** Plain-language, server-authored explanation (includes the credit numbers). */
  message: string;
}

/**
 * Renders an out-of-credits chat error as a plain-language notice instead of the
 * dead-end raw error text. Shown by ReplyContainer when a quest's
 * `errorCode === 'insufficient_credits'`.
 *
 * The remediation CTAs (Subscribe + Add Credits, mirroring the SessionWarnings
 * out-of-credits banner) are only shown when the active account can actually buy
 * credits. Org accounts can't self-purchase - CreditsModal hides packages for them
 * via the same `canPurchaseCredits` check - so for orgs we suppress the dead-end
 * buttons and let the server-authored message point them at their administrator.
 */
export const InsufficientCreditsNotice = ({ message }: InsufficientCreditsNoticeProps) => {
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const canPurchaseCredits = !selectedAccount || selectedAccount.personal;

  return (
    <Alert
      data-testid="insufficient-credits-notice"
      variant="soft"
      color="warning"
      startDecorator={<WarningAmberRoundedIcon />}
      sx={{ alignItems: 'flex-start', gap: 1.5 }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
        <Typography level="body-sm" data-testid="insufficient-credits-message">
          {message}
        </Typography>
        {canPurchaseCredits && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }} data-testid="insufficient-credits-actions">
            <SubscribeButton />
            <SessionCreditsButton />
          </Box>
        )}
      </Box>
    </Alert>
  );
};
