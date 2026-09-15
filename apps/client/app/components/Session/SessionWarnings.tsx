import { Box, IconButton, Typography, useTheme } from '@mui/joy';
import { keyframes } from '@mui/system';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import { SubscribeButton, SessionCreditsButton } from './SessionCreditsButtons';

const fadeIn = keyframes`
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
`;

// Attention-grabbing pulse animation for the warning container
const pulseGlow = keyframes`
  0%, 100% {
    box-shadow: 0 0 8px rgba(200, 50, 50, 0.4), inset 0 0 20px rgba(200, 50, 50, 0.05);
  }
  50% {
    box-shadow: 0 0 20px rgba(200, 50, 50, 0.6), inset 0 0 30px rgba(200, 50, 50, 0.1);
  }
`;

// Subtle icon pulse
const iconPulse = keyframes`
  0%, 100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.1);
    opacity: 0.85;
  }
`;

interface NoModelsWarningProps {
  show: boolean;
}

export function NoModelsWarning({ show }: NoModelsWarningProps) {
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
            You don&apos;t have access to any AI models.
          </Typography>
          <Typography fontSize="10px" sx={{ color: 'text.secondary' }}>
            Please contact your administrator to request the appropriate permissions.
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

interface CreditsWarningProps {
  show: boolean;
}

// Softer pulse animation for low credits (warning state, not danger)
const warningPulseGlow = keyframes`
  0%, 100% {
    box-shadow: 0 0 6px rgba(234, 179, 8, 0.3), inset 0 0 15px rgba(234, 179, 8, 0.03);
  }
  50% {
    box-shadow: 0 0 14px rgba(234, 179, 8, 0.45), inset 0 0 20px rgba(234, 179, 8, 0.06);
  }
`;

interface LowCreditsWarningProps {
  show: boolean;
  currentCredits: number;
  onDismiss: () => void;
}

export function LowCreditsWarning({ show, currentCredits, onDismiss }: LowCreditsWarningProps) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  if (!show) return null;

  return (
    <Box
      data-testid="session-low-credits-warning"
      sx={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: isDarkMode
          ? 'linear-gradient(135deg, rgba(120, 80, 20, 0.95) 0%, rgba(80, 55, 15, 0.98) 100%)'
          : 'linear-gradient(135deg, rgba(254, 249, 195, 0.98) 0%, rgba(254, 240, 138, 0.98) 100%)',
        borderRadius: '8px',
        border: isDarkMode ? '2px solid rgba(234, 179, 8, 0.6)' : '2px solid rgba(202, 138, 4, 0.5)',
        px: 2,
        py: 1,
        zIndex: 1000,
        animation: `${warningPulseGlow} 3s ease-in-out infinite`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <WarningAmberRoundedIcon
          data-testid="low-credits-warning-icon"
          sx={{
            fontSize: '26px',
            color: isDarkMode ? '#fbbf24' : '#ca8a04',
            filter: isDarkMode ? 'drop-shadow(0 0 4px rgba(251, 191, 36, 0.4))' : 'none',
          }}
        />
        <Box>
          <Typography
            data-testid="low-credits-warning-text"
            sx={{
              fontSize: '17px',
              fontWeight: 700,
              color: isDarkMode ? '#fef08a' : '#854d0e',
              letterSpacing: '-0.01em',
              textShadow: isDarkMode ? '0 1px 2px rgba(0,0,0,0.3)' : 'none',
            }}
          >
            Running Low on Credits
          </Typography>
          <Typography
            sx={{
              fontSize: '13px',
              color: isDarkMode ? 'rgba(254, 240, 138, 0.85)' : '#a16207',
              mt: 0.25,
            }}
          >
            Only {currentCredits.toLocaleString()} credits remaining — add more to avoid interruption
          </Typography>
        </Box>
      </Box>
      <Box data-testid="low-credits-warning-actions" display="flex" gap={1.5} alignItems="center">
        <SessionCreditsButton />
        <IconButton
          data-testid="low-credits-warning-dismiss"
          size="sm"
          variant="plain"
          onClick={onDismiss}
          sx={{
            color: isDarkMode ? 'rgba(254, 240, 138, 0.7)' : '#a16207',
            '&:hover': {
              backgroundColor: isDarkMode ? 'rgba(254, 240, 138, 0.1)' : 'rgba(161, 98, 7, 0.1)',
            },
          }}
        >
          <CloseRoundedIcon />
        </IconButton>
      </Box>
    </Box>
  );
}

export function CreditsWarning({ show }: CreditsWarningProps) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  if (!show) return null;

  return (
    <Box
      data-testid="session-credits-warning"
      sx={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: isDarkMode
          ? 'linear-gradient(135deg, rgba(120, 30, 30, 0.95) 0%, rgba(80, 20, 20, 0.98) 100%)'
          : 'linear-gradient(135deg, rgba(254, 226, 226, 0.98) 0%, rgba(254, 202, 202, 0.98) 100%)',
        borderRadius: '8px',
        border: isDarkMode ? '2px solid rgba(239, 68, 68, 0.6)' : '2px solid rgba(220, 38, 38, 0.4)',
        px: 2,
        py: 1,
        zIndex: 1000,
        animation: `${pulseGlow} 2s ease-in-out infinite`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <WarningAmberRoundedIcon
          data-testid="credits-warning-icon"
          sx={{
            fontSize: '28px',
            color: isDarkMode ? '#fbbf24' : '#dc2626',
            animation: `${iconPulse} 2s ease-in-out infinite`,
            filter: isDarkMode ? 'drop-shadow(0 0 6px rgba(251, 191, 36, 0.5))' : 'none',
          }}
        />
        <Box>
          <Typography
            data-testid="credits-warning-text"
            sx={{
              fontSize: '18px',
              fontWeight: 700,
              color: isDarkMode ? '#fecaca' : '#991b1b',
              letterSpacing: '-0.01em',
              textShadow: isDarkMode ? '0 1px 2px rgba(0,0,0,0.3)' : 'none',
            }}
          >
            Out of Credits
          </Typography>
          <Typography
            sx={{
              fontSize: '13px',
              color: isDarkMode ? 'rgba(254, 202, 202, 0.85)' : '#b91c1c',
              mt: 0.25,
            }}
          >
            Add credits or subscribe to continue
          </Typography>
        </Box>
      </Box>
      <Box data-testid="credits-warning-actions" display="flex" gap={1.5} alignItems="center">
        <SubscribeButton />
        <Typography
          sx={{
            fontSize: '13px',
            color: isDarkMode ? 'rgba(254, 202, 202, 0.7)' : '#7f1d1d',
            fontWeight: 500,
          }}
        >
          or
        </Typography>
        <SessionCreditsButton />
      </Box>
    </Box>
  );
}
