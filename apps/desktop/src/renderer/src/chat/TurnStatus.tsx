import { useEffect, useState } from 'react';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { describeSplit, statusFields, type TurnProgress } from './statusLine';

const pulse = keyframes({
  '0%, 100%': { opacity: 0.3 },
  '50%': { opacity: 1 },
});

/**
 * The one quiet line while a turn is in flight: elapsed, tokens, activity.
 *
 * It takes the composer's own row above the controls, and the idle Ready/Working indicator
 * stands down while it is there, so exactly one element on screen speaks for whether a reply
 * is running. The row is its own because this line shares nothing with the model picker: next
 * to it, three fields of elapsed-tokens-activity were squeezed to an ellipsis at any window
 * width short of very wide, which is how a working indicator became invisible.
 *
 * Drawn from `turn` alone, which is nulled on every way a turn can end - finished, failed,
 * stopped - so the line cannot outlive the thing it describes. A stale "3m 7s . Running
 * tools..." sitting under a finished answer is the failure this shape invites.
 */
export function TurnStatus({ turn, activity }: { turn: TurnProgress | null; activity: string }) {
  const [now, setNow] = useState(() => Date.now());
  const startedAt = turn?.startedAt ?? null;

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!turn) return null;

  return (
    <Stack direction="row" spacing={0.75} alignItems="baseline" data-testid="chat-turn-status">
      <Typography
        level="body-xs"
        textColor="text.tertiary"
        aria-hidden
        sx={{ animation: `${pulse} 1.4s ease-in-out infinite`, lineHeight: 1 }}
      >
        {/* The variation selector forces the text form: bare U+2733 renders as a colour emoji
            on macOS, which is the one loud thing in a line meant to be ignorable. */}
        {'\u2733\ufe0e'}
      </Typography>
      {/* Wraps rather than truncating. The activity field is the last one and the first to be
          cut, and it is the only field that says what the turn is actually doing. */}
      <Typography
        level="body-xs"
        textColor="text.tertiary"
        title={describeSplit(turn.usage) ?? undefined}
        data-testid="chat-turn-status-text"
      >
        {statusFields(turn, now, activity).join(' \u00b7 ')}
      </Typography>
    </Stack>
  );
}
