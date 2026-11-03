import { memo, useEffect, useState } from 'react';
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
  type ReplyStat,
  type ReplyStatId,
} from './replyStats';
import { REPLY_STATS_RAIL_INSET, REPLY_STATS_RAIL_WIDTH, useReplyStatsPrefs } from './replyStatsPrefs';
import { describeReplyCost, formatCreditsSpent, type TurnProgress } from './statusLine';

/** One row's height, in px: body-xs at its own line height. */
export const RAIL_ROW_HEIGHT = 18;

/**
 * The least distance from the end of one reply to the start of the next, in px: the thread's 24px
 * gap, the shortest turn that can sit between two replies (a one-line relay row), and the gap again.
 */
const NEXT_REPLY_CLEARANCE = 72;

/**
 * How tall a reply has to be for a rail of `rows` to end before the next reply's begins. The
 * rail is out of flow, so a one-line answer with a full rail would otherwise run into the next.
 */
export function railReserve(rows: number): number {
  return Math.max(0, rows * RAIL_ROW_HEIGHT - NEXT_REPLY_CLEARANCE);
}

interface RailContent {
  /** Every stat the reply has, for the title. */
  rows: ReplyStat[];
  /** The ones the user has ticked, for the rows. */
  shown: ReplyStat[];
  credits: string | null;
  usage: ChatUsage | null | undefined;
}

/** What a reply's rail shows: the live turn's figures while it runs, the stored ones after. */
export function railContent(
  message: ChatMessage,
  turn: TurnProgress | null | undefined,
  now: number,
  hidden: ReadonlySet<ReplyStatId>
): RailContent {
  const usage = turn ? turn.usage : message.usage;
  const rows = turn ? replyStats({ stats: liveReplyStats(turn, now), usage }, { live: true }) : messageStats(message);
  return { rows, shown: rows.filter(row => !hidden.has(row.id)), credits: formatCreditsSpent(usage), usage };
}

/** The minimum height a reply needs while its rail is drawn; see railReserve. */
export function useRailReserve(message: ChatMessage, turn: TurnProgress | null | undefined, rail: boolean): number {
  const { hidden } = useReplyStatsPrefs();
  if (!rail) return 0;
  // The row count does not depend on the clock, so the last stamp stands in for it.
  const { shown, credits } = railContent(message, turn, turn?.lastEventAt ?? turn?.startedAt ?? 0, hidden);
  return railReserve(shown.length + (credits ? 1 : 0));
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
  estimate,
  testId,
}: {
  label: string;
  value: string;
  estimate?: string;
  testId: string;
}) {
  return (
    <Box
      sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}
      title={estimate}
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

/**
 * A reply's stats as margin notes left of it, top-aligned with its first line.
 *
 * Absolute inside the turn, so it scrolls and windows with its reply and moves nothing; the
 * sticky block inside keeps it in view down a long reply and lets it leave with the reply's end.
 * No card or border, so it reads as notes rather than as a panel competing with the text.
 */
export const ReplyStatsRail = memo(function ReplyStatsRail({
  message,
  turn,
}: {
  message: ChatMessage;
  /** The turn in flight, while this is the reply it is writing. */
  turn?: TurnProgress | null;
}) {
  const { hidden } = useReplyStatsPrefs();
  const showDollars = useShowDollarCosts();
  const now = useClock(turn?.startedAt ?? null);
  const { rows, shown, credits, usage } = railContent(message, turn, now, hidden);
  if (shown.length === 0 && !credits) return null;
  const title = [describeReplyStats(rows), describeReplyCost(usage, showDollars)].filter(
    (line): line is string => line !== null
  );

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: `calc(100% + ${REPLY_STATS_RAIL_INSET}px)`,
        width: REPLY_STATS_RAIL_WIDTH,
      }}
      data-testid="chat-reply-stats-rail"
    >
      <Box
        role="group"
        aria-label="Reply stats"
        // Native, as the hover footer's: a Joy tooltip per reply would mount a popper for every turn.
        title={title.length > 0 ? title.join('\n') : undefined}
        sx={{ position: 'sticky', top: 12 }}
      >
        {shown.map(row => (
          <RailRow
            key={row.id}
            label={REPLY_STAT_TEXT[row.id].label}
            value={row.value}
            {...(row.estimate ? { estimate: row.estimate } : {})}
            testId={`chat-reply-stat-${row.id}`}
          />
        ))}
        {credits && <RailRow label="Cost" value={credits} testId="chat-reply-stat-cost" />}
      </Box>
    </Box>
  );
});
