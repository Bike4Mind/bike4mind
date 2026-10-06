import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { ChevronIcon } from './icons';
import {
  activityDetail,
  describeSplit,
  hasActivityDetail,
  statusFields,
  withStall,
  type ActivityDetail,
  type TurnActivity,
  type TurnProgress,
} from './statusLine';

const pulse = keyframes({
  '0%, 100%': { opacity: 0.3 },
  '50%': { opacity: 1 },
});

/**
 * What the line discloses when it is opened: the live thing the thread is NOT showing.
 *
 * Only ever the hidden body of code being written, or one line about a stream that has gone
 * quiet - see TurnActivity for why there is nothing else to put here. The body arrives already
 * bounded, so this cannot grow with the turn; `maxHeight` is the second bound and a different
 * one, keeping a twelve-line tail from pushing the composer down the window.
 */
function ActivityDetailView({
  detail,
  id,
  panel,
}: {
  detail: ActivityDetail;
  id: string;
  panel: RefObject<HTMLDivElement | null>;
}) {
  return (
    <Box
      ref={panel}
      id={id}
      sx={{ minWidth: 0, pl: 1.5, borderLeft: '2px solid', borderColor: 'divider' }}
      data-testid="chat-turn-status-detail"
    >
      {detail.note && (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="chat-turn-status-detail-note">
          {detail.note}
        </Typography>
      )}

      {detail.body && (
        <Typography
          level="body-xs"
          fontFamily="monospace"
          textColor="text.tertiary"
          sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflowY: 'auto', mt: 0.25 }}
          data-testid="chat-turn-status-detail-body"
        >
          {detail.body}
        </Typography>
      )}
    </Box>
  );
}

/**
 * The one quiet line while a turn is in flight: elapsed, tokens, and what is happening now.
 *
 * It takes the composer's own row above the controls, and the idle Ready/Working indicator
 * stands down while it is there, so exactly one element on screen speaks for whether a reply
 * is running. The row is its own because this line shares nothing with the model picker: next
 * to it, three fields of elapsed-tokens-activity were squeezed to an ellipsis at any window
 * width short of very wide, which is how a working indicator became invisible.
 *
 * Drawn from `turn` alone, which is nulled on every way a turn can end - finished, failed,
 * stopped - so the line cannot outlive the thing it describes. A stale "3m 7s . Running
 * tools..." sitting under a finished answer is the failure this shape invites. Unmounting with
 * the turn is also what resets the disclosure, so each turn starts collapsed.
 *
 * The clock here is the only one: `now` drives the elapsed field AND the stall check, which is
 * why withStall is applied at this level rather than where the activity is described.
 */
export function TurnStatus({ turn, activity }: { turn: TurnProgress | null; activity: TurnActivity }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const startedAt = turn?.startedAt ?? null;

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  // The line sits at the bottom of a scrolled transcript, so what opening it reveals can open
  // below the fold - which reads as a control that did nothing. Only on the toggle, never on the
  // stream's own updates, which have the thread's own autoscroll.
  useEffect(() => {
    if (open) panel.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  if (!turn) return null;

  const live = withStall(activity, turn, now);
  const expandable = hasActivityDetail(live);
  // The one place a detail is ever built, and only while it is on screen.
  const detail = open && expandable ? activityDetail(live) : null;

  // One line at any width. It truncates rather than wrapping now that the whole of it is one
  // click away: a second line here pushes the composer down every time a tool reports progress.
  const line = (
    <Typography
      component="span"
      level="body-xs"
      textColor="text.tertiary"
      title={describeSplit(turn.usage) ?? undefined}
      noWrap
      sx={{ minWidth: 0, display: 'block' }}
      data-testid="chat-turn-status-text"
    >
      {statusFields(turn, now, live.label).join(' \u00b7 ')}
    </Typography>
  );

  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }} data-testid="chat-turn-status">
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          aria-hidden
          sx={{ animation: `${pulse} 1.4s ease-in-out infinite`, lineHeight: 1, flex: '0 0 auto' }}
        >
          {/* The variation selector forces the text form: bare U+2733 renders as a colour emoji
              on macOS, which is the one loud thing in a line meant to be ignorable. */}
          {'\u2733\ufe0e'}
        </Typography>
        {/* A real button, not a row with an onClick: this is the only way to the detail, so it
            has to be reachable by keyboard and has to say whether it is open. */}
        {expandable ? (
          <Button
            variant="plain"
            color="neutral"
            size="sm"
            onClick={() => setOpen(value => !value)}
            aria-expanded={open}
            aria-controls={detailId}
            endDecorator={<ChevronIcon open={open} />}
            data-testid="chat-turn-status-toggle"
            sx={{
              minWidth: 0,
              minHeight: 0,
              px: 0,
              py: 0,
              fontWeight: 'normal',
              '--Button-gap': '4px',
              '&:hover': { bgcolor: 'transparent', opacity: 0.85 },
            }}
          >
            {line}
          </Button>
        ) : (
          line
        )}
      </Stack>
      {detail && <ActivityDetailView detail={detail} id={detailId} panel={panel} />}
    </Stack>
  );
}
