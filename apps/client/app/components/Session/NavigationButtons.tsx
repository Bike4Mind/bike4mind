import { FC } from 'react';
import { Box, Button, Stack, Tooltip, Typography } from '@mui/joy';
import { Explore as NavigateIcon } from '@mui/icons-material';
import { useNavigationExecutor } from '@client/app/hooks/useNavigationExecutor';
import type { NavigationIntent } from '@bike4mind/common';

interface NavigationButtonsProps {
  navigationIntents: NavigationIntent[];
}

/**
 * Inline navigation buttons rendered after LLM markdown content.
 * Follows the PendingActionButtons pattern from PromptReplies.
 * User clicks to navigate - the AI never auto-navigates.
 */
const NavigationButtons: FC<NavigationButtonsProps> = ({ navigationIntents }) => {
  const execute = useNavigationExecutor();

  if (!navigationIntents || navigationIntents.length === 0) return null;

  return (
    <Box
      sx={{
        mt: 1.5,
        p: 1.5,
        borderRadius: 'md',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
        bgcolor: 'background.surface',
      }}
    >
      <Typography level="body-xs" sx={{ mb: 1, color: 'neutral.500', fontWeight: 600 }}>
        Suggested Navigation
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {navigationIntents.map(intent => (
          <Tooltip key={intent.viewId} title={intent.reason} placement="top" arrow>
            <Button
              variant="outlined"
              color="primary"
              size="sm"
              startDecorator={<NavigateIcon sx={{ fontSize: 16 }} />}
              onClick={() => execute(intent)}
              data-testid={`nav-btn-${intent.viewId}`}
              sx={{
                fontWeight: 500,
                borderRadius: 'lg',
              }}
            >
              {intent.label}
            </Button>
          </Tooltip>
        ))}
      </Stack>
    </Box>
  );
};

export default NavigationButtons;
