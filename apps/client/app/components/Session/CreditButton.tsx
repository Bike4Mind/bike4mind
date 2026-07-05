import { Typography, Tooltip, Button, useTheme, Box } from '@mui/joy';
import Bike4MindIcon from '../svgs/icons/Bike4MindIcon';
import { FC, useState, useMemo } from 'react';
import CreditsModal from '../subscription/CreditsModal';

/**
 * Threshold below which credits are considered "low".
 * Used by both CreditButton (visual warning state) and LowCreditsWarning (overlay prompt).
 */
export const LOW_CREDITS_THRESHOLD = 1000;

interface CreditsButtonProps {
  currentCredits?: number;
}

const SessionCreditsButton: FC<CreditsButtonProps> = ({ currentCredits = 0 }) => {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const [isOpen, setIsOpen] = useState(false);

  const buttonColor = currentCredits <= 0 ? 'danger' : currentCredits < LOW_CREDITS_THRESHOLD ? 'warning' : 'neutral';

  const tooltipTitle = useMemo(() => {
    // Common message for low/no credits
    const creditWarningMessage = "Buy more credits to make sure your work won't be interrupted";

    if (currentCredits <= 0) {
      return <CreditTooltipContent title="Ready for Refill" message={creditWarningMessage} />;
    } else if (currentCredits < LOW_CREDITS_THRESHOLD) {
      return <CreditTooltipContent title="Low on Credits!" message={creditWarningMessage} />;
    } else {
      return 'Credits';
    }
  }, [currentCredits]);

  return (
    <>
      <Tooltip
        title={tooltipTitle}
        arrow
        variant="outlined"
        placement="top"
        color={buttonColor}
        sx={{
          borderColor: theme.palette[buttonColor][400],
          backgroundColor: isDarkMode ? theme.palette[buttonColor][800] : theme.palette[buttonColor][100],
          '& .MuiTooltip-arrow:before': {
            borderTopColor: theme.palette[buttonColor][400],
            borderRightColor: theme.palette[buttonColor][400],
          },
        }}
      >
        <Button
          variant="outlined"
          sx={{
            gap: '8px',
            borderColor: theme.palette[buttonColor][400],
            backgroundColor: isDarkMode ? theme.palette[buttonColor][800] : theme.palette[buttonColor][100],
          }}
          onClick={() => setIsOpen(true)}
        >
          <Bike4MindIcon size="15px" fill={theme.palette[buttonColor][400]} />
          <Typography
            level="body-sm"
            sx={{
              color: theme.palette[buttonColor][400],
            }}
          >
            {currentCredits}
          </Typography>
        </Button>
      </Tooltip>
      <CreditsModal open={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
};

// Helper component for tooltip content
const CreditTooltipContent = ({ title, message }: { title: string; message: string }) => (
  <Box sx={{ p: '10px', maxWidth: '268px' }}>
    <Typography sx={{ fontWeight: 500, fontSize: '16px', lineHeight: '16px', mb: '8px' }}>{title}</Typography>
    <Typography sx={{ fontSize: '14px', lineHeight: '140%', opacity: 0.5 }}>{message}</Typography>
  </Box>
);

export default SessionCreditsButton;
