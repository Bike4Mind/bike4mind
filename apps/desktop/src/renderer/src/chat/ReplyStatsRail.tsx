import { Component, memo, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import type { ChatMessage, ChatUsage } from '@shared/chat';
import { useShowDollarCosts } from './costDisplay';
import {
  describeReplyStats,
  liveReplyStats,
  messageStats,
  replyStats,
  REPLY_STAT_TEXT,
  speakReplyStats,
  statDetail,
  type ReplyStat,
  type ReplyStatId,
} from './replyStats';
import { REPLY_STATS_RAIL_INSET, REPLY_STATS_RAIL_WIDTH, useReplyStatsPrefs } from './replyStatsPrefs';
import { describeReplyCost, formatCreditsSpent, type TurnProgress } from './statusLine';

/**
 * The thread's turns as a grid: a zero-width first column for the rails, which draw out to its
 * left, and the turns in the second. The turns between two replies are one item (see
 * TurnGroup), and a rail spans its reply's row and that group's, so the browser sizes the rows to
 * hold it: a reply never moves for its own rail, and nothing is measured. Extra height lands
 * between the reply and its group, whose turns stay one gap apart, and a prompt stays one gap
 * above its own answer.
 */
export const turnGridSx = {
  display: 'grid',
  gridTemplateColumns: '0 minmax(0, 1fr)',
  rowGap: 3,
  // The specificity of Joy's Stack spacing, which this replaces: a turn's own margin never applies.
  '& > :not(style)': { gridColumn: '2', alignSelf: 'end', margin: 0 },
  '& > [data-reply]': { alignSelf: 'start' },
  '& > [data-rail-for]': { gridColumn: '1', alignSelf: 'stretch' },
} as const;

interface RailContent {
  /** Every stat the reply has, for the title. */
  rows: ReplyStat[];
  /** The ones the user has ticked, for the rows. */
  shown: ReplyStat[];
  credits: string | null;
  usage: ChatUsage | null | undefined;
}

/**
 * What a reply's rail shows: the live turn's figures while it runs, on top of what a continued
 * reply's earlier runs stored, and the stored ones after.
 */
export function railContent(
  message: ChatMessage,
  turn: TurnProgress | null | undefined,
  now: number,
  hidden: ReadonlySet<ReplyStatId>
): RailContent {
  if (!turn) {
    const rows = messageStats(message);
    const usage = message.usage;
    return { rows, shown: rows.filter(row => !hidden.has(row.id)), credits: formatCreditsSpent(usage), usage };
  }
  // A resumed run's usage totals include the earlier runs'; until the first lands, the stored one stands.
  const usage = turn.usage ?? message.usage;
  // A continued reply stored before stats were kept: its earlier time is unknown, so none is shown.
  const stats = turn.continued && !message.stats ? undefined : liveReplyStats(turn, now, message.stats);
  const rows = replyStats({ stats, usage }, { live: true });
  return { rows, shown: rows.filter(row => !hidden.has(row.id)), credits: null, usage };
}

/** Ticks once a second while a turn runs, as the status line's own clock does. */
function useClock(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return now;
}

function RailRow({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: string;
  detail?: string | null;
  testId: string;
}) {
  return (
    <Box
      sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}
      title={detail ?? undefined}
      data-testid={testId}
    >
      <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>
        {label}
      </Typography>
      <Typography
        level="body-xs"
        textColor="text.secondary"
        noWrap
        sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Typography>
    </Box>
  );
}

const visuallyHiddenSx = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

/** The id of a reply's rail group, which its reply owns for a screen reader. */
export const railGroupId = (messageId: string): string => `reply-stats-${messageId}`;

interface RailProps {
  message: ChatMessage;
  /** The turn in flight, while this is the reply it is writing. */
  turn?: TurnProgress | null;
  /** How many of the thread's grid rows the rail runs down, its reply's first; see railRows. */
  span: number;
}

const drawnRails = new Set<string>();
const drawnListeners = new Set<() => void>();

function setRailDrawn(id: string, drawn: boolean): void {
  if (drawnRails.has(id) === drawn) return;
  if (drawn) drawnRails.add(id);
  else drawnRails.delete(id);
  drawnListeners.forEach(listener => listener());
}

/** Whether the rail for this reply is on screen: it draws nothing when it has nothing to show, or has thrown. */
export function useRailDrawn(id: string): boolean {
  return useSyncExternalStore(
    listener => {
      drawnListeners.add(listener);
      return () => drawnListeners.delete(listener);
    },
    () => drawnRails.has(id)
  );
}

/** A rail is a margin note: one that throws drops itself rather than the thread. */
class RailErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * A reply's stats as margin notes left of it, top-aligned with its first line: the grid cell in
 * turnGridSx's rail column beside the reply and the turns after it. The sticky block inside keeps
 * it in view down a long reply. No card, only a hairline on the reply's side, so it reads as notes
 * set apart from the text rather than as a panel competing with it.
 *
 * A screen reader gets one sentence per reply in place of a label and a value per row, so a long
 * thread reads as its replies with a short note after each.
 */
export const ReplyStatsRail = memo(function ReplyStatsRail(props: RailProps) {
  return (
    // Keyed on live or stored, so a rail that threw on a live frame gets another go on the stored stats.
    <RailErrorBoundary key={props.turn ? 'live' : 'stored'}>
      <RailCell {...props} />
    </RailErrorBoundary>
  );
});

function RailCell({ message, turn, span }: RailProps) {
  const { hidden } = useReplyStatsPrefs();
  const showDollars = useShowDollarCosts();
  const now = useClock(turn?.startedAt ?? null);
  const { rows, shown, credits, usage } = railContent(message, turn, now, hidden);
  const drawn = shown.length > 0 || !!credits;
  useLayoutEffect(() => setRailDrawn(message.id, drawn), [message.id, drawn]);
  useLayoutEffect(() => () => setRailDrawn(message.id, false), [message.id]);
  if (!drawn) return null;
  const title = [describeReplyStats(rows), describeReplyCost(usage, showDollars)].filter(
    (line): line is string => line !== null
  );

  return (
    <Box
      // Never the scroll anchor: stuck rows hold still while the text beside them moves.
      sx={{ minWidth: 0, overflowAnchor: 'none' }}
      style={{ gridRow: `span ${span}` }}
      data-rail-for={message.id}
      data-testid="chat-reply-stats-rail"
    >
      <Box
        id={railGroupId(message.id)}
        role="group"
        aria-label="Reply stats"
        // Native, as the hover footer's: a Joy tooltip per reply would mount a popper for every turn.
        title={title.length > 0 ? title.join('\n') : undefined}
        sx={{
          position: 'sticky',
          top: 12,
          width: REPLY_STATS_RAIL_WIDTH,
          ml: `${-(REPLY_STATS_RAIL_WIDTH + REPLY_STATS_RAIL_INSET)}px`,
          pr: 1.25,
          borderRight: '1px solid',
          borderColor: 'divider',
          // Margin notes: a drag across the reply should not pick them up.
          userSelect: 'none',
        }}
      >
        <Box aria-hidden>
          {shown.map(row => (
            <RailRow
              key={row.id}
              label={REPLY_STAT_TEXT[row.id].label}
              value={row.value}
              detail={statDetail(row)}
              testId={`chat-reply-stat-${row.id}`}
            />
          ))}
          {credits && <RailRow label="Cost" value={credits} testId="chat-reply-stat-cost" />}
        </Box>
        <Typography component="span" sx={visuallyHiddenSx} data-testid="chat-reply-stats-spoken">
          {speakReplyStats(shown, credits)}
        </Typography>
      </Box>
    </Box>
  );
}
