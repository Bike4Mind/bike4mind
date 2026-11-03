import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
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

/** The clear space between one rail's last row and the next rail's first, in px. */
export const RAIL_GAP = 16;

export interface RailBox {
  /** The reply's message id. */
  id: string;
  /** Where the rail is drawn, in viewport px, with its reply's push. */
  top: number;
  /** The push it was drawn with. */
  push: number;
  height: number;
}

export interface RailSpacing {
  /** How far each reply is pushed down, in px; a reply left where it is has no entry. */
  pushes: ReadonlyMap<string, number>;
  /** Room after the thread's last turn for a rail that runs past it, in px. */
  endSpace: number;
}

export const NO_RAIL_SPACING: RailSpacing = { pushes: new Map(), endSpace: 0 };

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * Where each reply goes so its rail starts RAIL_GAP below the one above it. A rail sits left of
 * the column, so it runs on beside whatever follows its reply and only another rail can meet it;
 * a reply is pushed down only when its rail would. `end` is where the thread's last turn ends,
 * and the room after it keeps the last rail inside the scroll, which the thread follows to.
 */
export function railSpacing(rails: readonly RailBox[], end: number): RailSpacing {
  const pushes = new Map<string, number>();
  // How far this spacing moves what follows, against how it is drawn now.
  let shift = 0;
  let above: number | null = null;
  for (const rail of rails) {
    const drawnPush = finite(rail.push);
    const height = finite(rail.height);
    if (height <= 0) {
      shift -= drawnPush;
      continue;
    }
    const unpushed = finite(rail.top) - drawnPush + shift;
    const push: number = above === null ? 0 : Math.max(0, Math.ceil(above + RAIL_GAP - unpushed));
    if (push > 0) pushes.set(rail.id, push);
    shift += push - drawnPush;
    above = unpushed + push + height;
  }
  const endSpace = above === null ? 0 : Math.max(0, Math.ceil(above - (finite(end) + shift)));
  return { pushes, endSpace };
}

function sameSpacing(a: RailSpacing, b: RailSpacing): boolean {
  if (a.endSpace !== b.endSpace || a.pushes.size !== b.pushes.size) return false;
  for (const [id, push] of a.pushes) if (b.pushes.get(id) !== push) return false;
  return true;
}

function measureRails(column: HTMLElement, end: HTMLElement, drawn: RailSpacing): RailSpacing {
  const rails = Array.from(column.querySelectorAll<HTMLElement>('[data-rail-for]'), rail => {
    const id = rail.dataset.railFor ?? '';
    const rows = rail.firstElementChild;
    return {
      id,
      top: rail.getBoundingClientRect().top,
      push: drawn.pushes.get(id) ?? 0,
      height: rows instanceof HTMLElement ? rows.offsetHeight : 0,
    };
  });
  return railSpacing(rails, end.getBoundingClientRect().top);
}

/**
 * The thread's railSpacing, measured after every render and whenever the column resizes. `end`
 * is the element after the thread's last turn, the one the auto-scroll brings into view.
 */
export function useRailSpacing(
  column: RefObject<HTMLElement | null>,
  end: RefObject<HTMLElement | null>,
  enabled: boolean
): RailSpacing {
  // A stat ticked in Settings changes a rail's height without rendering the thread.
  useReplyStatsPrefs();
  const [spacing, setSpacing] = useState<RailSpacing>(NO_RAIL_SPACING);
  const drawn = useRef(spacing);

  const measure = useCallback(() => {
    const next =
      enabled && column.current && end.current
        ? measureRails(column.current, end.current, drawn.current)
        : NO_RAIL_SPACING;
    if (!sameSpacing(drawn.current, next)) setSpacing(next);
  }, [column, end, enabled]);

  useLayoutEffect(() => {
    drawn.current = spacing;
    measure();
  });

  useEffect(() => {
    const el = column.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [column, enabled, measure]);

  return enabled ? spacing : NO_RAIL_SPACING;
}

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

/**
 * A reply's stats as margin notes left of it, top-aligned with its first line.
 *
 * Absolute inside the turn, so it scrolls and windows with its reply and runs on past a short one;
 * the sticky block inside keeps it in view down a long reply and lets it leave with the reply's
 * end. No card, only a hairline on the reply's side, so it reads as notes set apart from the text
 * rather than as a panel competing with it.
 *
 * A screen reader gets one sentence per reply in place of a label and a value per row, so a long
 * thread reads as its replies with a short note after each.
 */
export const ReplyStatsRail = memo(function ReplyStatsRail({
  message,
  turn,
  push = 0,
}: {
  message: ChatMessage;
  /** The turn in flight, while this is the reply it is writing. */
  turn?: TurnProgress | null;
  /** The reply's push down from the top of its turn; see railSpacing. */
  push?: number;
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
        top: push,
        bottom: 0,
        right: `calc(100% + ${REPLY_STATS_RAIL_INSET}px)`,
        width: REPLY_STATS_RAIL_WIDTH,
      }}
      data-rail-for={message.id}
      data-testid="chat-reply-stats-rail"
    >
      <Box
        role="group"
        aria-label="Reply stats"
        // Native, as the hover footer's: a Joy tooltip per reply would mount a popper for every turn.
        title={title.length > 0 ? title.join('\n') : undefined}
        sx={{
          position: 'sticky',
          top: 12,
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
});
