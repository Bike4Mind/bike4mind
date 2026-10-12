import { Alert, Box, Typography } from '@mui/joy';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { CreditOfferActions } from './CreditOfferActions';

interface InsufficientCreditsNoticeProps {
  /** Plain-language, server-authored explanation (includes the credit numbers). */
  message: string;
}

/**
 * Renders an out-of-credits chat error as a plain-language notice instead of the
 * dead-end raw error text. Shown by ReplyContainer when a quest's
 * `errorCode === 'insufficient_credits'`.
 *
 * The actions come from CreditOfferActions, shared with the SessionWarnings banners: Pro
 * and a credit pack for personal accounts, Ask your admin for org members.
 */
export const InsufficientCreditsNotice = ({ message }: InsufficientCreditsNoticeProps) => {
  return (
    <Alert
      data-testid="insufficient-credits-notice"
      variant="soft"
      color="warning"
      startDecorator={<WarningAmberRoundedIcon />}
      sx={{ alignItems: 'center', gap: 1.5, p: '16px' }}
    >
      {/* Message and actions on one row, the actions trailing - as on every card that carries
          both. Wraps on a narrow pane rather than squeezing the buttons. */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          width: '100%',
        }}
      >
        <Typography
          level="body-sm"
          textColor="text.secondary"
          sx={{ flex: 1, minWidth: '240px' }}
          data-testid="insufficient-credits-message"
        >
          {message}
        </Typography>
        <Box sx={{ flexShrink: 0 }} data-testid="insufficient-credits-actions">
          <CreditOfferActions moment="out" />
        </Box>
      </Box>
    </Alert>
  );
};
