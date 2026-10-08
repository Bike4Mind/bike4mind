import { useState } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { ChevronIcon } from './icons';
import { shortenArgument } from './toolRows';

/**
 * How much of a thought the collapsed row names.
 *
 * The same cap the tool rows use for their arguments, so the two kinds of aside line up down
 * the left of a turn rather than one running past the other.
 */
function preview(reasoning: string): string {
  const head = shortenArgument(reasoning);
  return head ? `Thinking: ${head}` : 'Thinking';
}

/**
 * What the model thought before this round's prose, behind a row that is closed by default.
 *
 * The transcript showed none of this until now: the reasoning was captured, stored and read by
 * nothing, on the grounds that a turn's thinking is not its answer and a reply buried under
 * screens of it is not a reply. A collapsed row keeps that - the thinking is one line at rest
 * and the answer still runs the page - while giving the only readable record of how the turn
 * got there somewhere to be read.
 *
 * NEVER drawn for the round still streaming. The status line already speaks for the turn in
 * flight, and a live thought shown in both places at once is the same words twice on one screen.
 * See MessageThread, which decides that, and TurnStatus, which is the other half of it.
 *
 * No duration on the row, though the round records one: the time it measures means different
 * things on the two paths thinking arrives by - silence before the first token on one, the
 * reasoning text itself on the other - and a number that reads as "thought for 8s" on one model
 * and as something else on the next is worse than no number.
 *
 * The body is mounted only while it is open, rather than left in a closed `details` for the
 * browser to skip. A long session is hundreds of these, and the text behind one can run to tens
 * of thousands of characters: closed, this row costs a line.
 */
export function ReasoningRow({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  if (!reasoning.trim()) return null;

  return (
    <Box sx={{ borderLeft: '2px solid', borderColor: 'divider', pl: 1.25 }}>
      <Box
        component="details"
        open={open}
        onToggle={event => setOpen(event.currentTarget.open)}
        data-testid="chat-reasoning-row"
      >
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
          data-testid="chat-reasoning-row-summary"
        >
          <Typography level="body-sm" textColor="inherit" noWrap sx={{ minWidth: 0, flex: '0 1 auto' }}>
            {preview(reasoning)}
          </Typography>
          <Box sx={{ display: 'flex', opacity: 0.6 }}>
            <ChevronIcon open={open} />
          </Box>
        </Stack>

        {/* Capped and scrollable for the same reason the tool results are: one turn's thinking
            can be longer than its answer, and a row that pushes the reply off the screen when
            opened is one nobody opens twice. */}
        {open && (
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto', py: 0.5 }}
            data-testid="chat-reasoning-row-body"
          >
            {reasoning}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
