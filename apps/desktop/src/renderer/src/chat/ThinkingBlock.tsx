import { useState } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { ChevronIcon } from './icons';

/**
 * A round's reasoning, collapsed to one row above its prose.
 *
 * Drawn in the tool rows' shape (ToolGroupRow) so a turn reads as one transcript of asides the
 * eye can skip, and closed by default: the reasoning is there for whoever wants the why, not
 * something to read past on the way to the answer.
 */
export function ThinkingBlock({ reasoning, thinking }: { reasoning: string; thinking: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <Box sx={{ borderLeft: '2px solid', borderColor: 'divider', pl: 1.25, mb: 0.75 }} data-testid="chat-thinking">
      <Box component="details" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <Stack
          component="summary"
          direction="row"
          spacing={0.75}
          alignItems="center"
          sx={{
            cursor: 'pointer',
            listStyle: 'none',
            py: 0.25,
            color: 'text.tertiary',
            '&::-webkit-details-marker': { display: 'none' },
            '&:hover': { color: 'text.secondary' },
          }}
          data-testid="chat-thinking-summary"
        >
          <Typography level="body-xs" textColor="inherit" sx={{ fontStyle: 'italic' }}>
            {thinking ? 'Thinking...' : 'Thought'}
          </Typography>
          <Box sx={{ display: 'flex', opacity: 0.6 }}>
            <ChevronIcon open={open} />
          </Box>
        </Stack>
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          sx={{ whiteSpace: 'pre-wrap', py: 0.5 }}
          data-testid="chat-thinking-text"
        >
          {reasoning}
        </Typography>
      </Box>
    </Box>
  );
}
