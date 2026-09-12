import { FC } from 'react';
import { Box, Button, Stack, Tooltip, Typography } from '@mui/joy';
import { useNavigationExecutor } from '@client/app/hooks/useNavigationExecutor';
import { compactButtonSx } from '@client/app/utils/buttonStyles';
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
      // A rule, not a card: the block sits at the foot of the reply body now, so it
      // separates itself from the answer instead of framing itself inside it - and
      // its own ground would have swallowed the buttons, which carry that colour.
      sx={{
        mt: '16px',
        pt: '16px',
        borderTop: '1px solid',
        borderColor: 'divider',
      }}
    >
      {/* display: block because Joy renders body-xs as a span, and a margin on an
          inline element is ignored - the gap below was coming from the line box. */}
      <Typography level="body-xs" sx={{ display: 'block', mb: '8px', color: 'text.primary', fontWeight: 600 }}>
        Suggested Navigation
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {navigationIntents.map(intent => (
          // The app's secondary action, at the same metrics as the ones in a brief
          // card: a suggestion is not the reply's own call to action.
          <Tooltip key={intent.viewId} title={intent.reason} placement="top" arrow>
            <Button
              variant="outlined"
              color="neutral"
              size="sm"
              onClick={() => execute(intent)}
              data-testid={`nav-btn-${intent.viewId}`}
              // The app's surface ground, not the reply bubble's: the buttons are
              // chrome the answer carries, so they sit on the app's own colour.
              sx={{ ...compactButtonSx, backgroundColor: 'background.surface' }}
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
