import { Box, Button, Divider, IconButton, Typography, useTheme } from '@mui/joy';
import { keyframes } from '@mui/system';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import { CreditOfferActions } from './CreditOfferActions';

const fadeIn = keyframes`
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
`;

interface NoModelsWarningProps {
  show: boolean;
  /** The model list failed to load - a transient fault, not a permissions problem. */
  loadError?: boolean;
  onRetry?: () => void;
}

export function NoModelsWarning({ show, loadError = false, onRetry }: NoModelsWarningProps) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  if (!show) return null;

  return (
    <Box
      data-testid="session-no-models-warning"
      sx={{
        top: '15px',
        left: '0',
        fontSize: '12px',
        position: 'absolute',
        width: '100%',
        height: '100%',
        backgroundColor: theme.palette.background.surface2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 1000,
        px: 1.5,
        animation: `${fadeIn} 0.25s ease-in`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <BlockRoundedIcon
          sx={{
            fontSize: '22px',
            color: isDarkMode ? 'danger.400' : 'danger.500',
            flexShrink: 0,
          }}
        />
        <Box>
          <Typography
            data-testid="no-models-warning-text"
            fontSize="12px"
            fontWeight="bold"
            sx={{ color: isDarkMode ? 'danger.400' : 'danger.500' }}
          >
            {loadError ? <>Couldn&apos;t load AI models.</> : <>You don&apos;t have access to any AI models.</>}
          </Typography>
          <Typography fontSize="10px" sx={{ color: 'text.secondary' }}>
            {loadError
              ? 'Check your connection and try again.'
              : 'Please contact your administrator to request the appropriate permissions.'}
          </Typography>
        </Box>
      </Box>
      {loadError && onRetry && (
        <Button size="sm" variant="soft" color="danger" onClick={onRetry} data-testid="no-models-retry-btn">
          Retry
        </Button>
      )}
    </Box>
  );
}

interface CreditsWarningProps {
  show: boolean;
}

interface LowCreditsWarningProps {
  show: boolean;
  currentCredits: number;
  onDismiss: () => void;
}

/**
 * Low but not out: an in-flow banner above the message box, so typing is never blocked. Dismissal
 * is the caller's to remember (see creditNudgeDismissal).
 */
export function LowCreditsWarning({ show, currentCredits, onDismiss }: LowCreditsWarningProps) {
  if (!show) return null;

  return (
    <Box
      data-testid="session-low-credits-warning"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        flexWrap: 'wrap',
        backgroundColor: 'background.level1',
        border: '1px solid',
        borderColor: 'warning.outlinedBorder',
        borderRadius: '8px',
        px: 1.5,
        py: 1,
        mb: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
        <WarningAmberRoundedIcon
          data-testid="low-credits-warning-icon"
          sx={{ fontSize: '22px', color: 'warning.plainColor', flexShrink: 0 }}
        />
        <Box>
          <Typography data-testid="low-credits-warning-text" level="title-sm">
            Running low on credits
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            {currentCredits.toLocaleString()} credits remaining. Your work isn&apos;t interrupted.
          </Typography>
        </Box>
      </Box>
      <Box data-testid="low-credits-warning-actions" display="flex" gap={1.5} alignItems="center">
        <CreditOfferActions moment="low" />
        <IconButton
          data-testid="low-credits-warning-dismiss"
          aria-label="Dismiss low credits notice"
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onDismiss}
        >
          <CloseRoundedIcon />
        </IconButton>
      </Box>
    </Box>
  );
}

/**
 * Out of credits: takes the place of the message box rather than covering it.
 * There is nothing to type into, so the box is not drawn at all - the block
 * sits above the toolbar, divided from it, and says what happened and what to
 * do in the same calm register as the rest of the composer.
 */
export function CreditsWarning({ show }: CreditsWarningProps) {
  if (!show) return null;

  return (
    // The 10px top padding matches the message row this replaces, which carries the
    // same padding to clear the grid's negative margin above it.
    <Box data-testid="session-credits-warning" sx={{ width: '100%', pt: '10px' }}>
      {/* One row on desktop. On a phone the row is too narrow for the copy and two
          buttons side by side, so the copy goes on top and the buttons share a full-width
          row under it, split evenly. */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between',
          gap: { xs: '12px', sm: 2 },
          py: '12px',
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            data-testid="credits-warning-text"
            level="title-sm"
            sx={{ fontSize: '14px', fontWeight: 500, color: 'danger.softColor' }}
          >
            Out of Credits
          </Typography>
          <Typography level="body-sm" sx={{ mt: '2px', fontSize: '13px', color: 'text.tertiary' }}>
            Your message is saved. Pick up where you left off once you have credits.
          </Typography>
        </Box>
        <Box data-testid="credits-warning-actions" sx={{ flexShrink: 0 }}>
          <CreditOfferActions moment="out" />
        </Box>
      </Box>
      <Divider />
    </Box>
  );
}
