import { Box, Chip, Stack, Typography, type ColorPaletteProp } from '@mui/joy';
import type { ComponentProps } from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  activeLaneCount,
  loopMaxConcurrent,
  loopStatusNeedsOwner,
  type B4MLLMTools,
  type ILoop,
  type ILoopHold,
  type ILoopWithUsage,
  type LoopCapacityLimit,
  type LoopHoldKind,
  type LoopStatus,
} from '@bike4mind/common';
import type { ToolAvailability } from '@pages/api/settings/serverConfig';
import { createMarkdownComponents } from '@client/app/components/Session/markdown/markdownComponents';
import { link } from '@client/app/components/Session/MarkdownLink';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { isToolKeyMissing } from '@client/app/utils/toolMapping';

const STATUS_COLOR: Record<LoopStatus, ColorPaletteProp> = {
  draft: 'neutral',
  live: 'success',
  paused: 'warning',
  needs_you: 'warning',
  error: 'danger',
};

const STATUS_LABEL: Record<LoopStatus, string> = {
  draft: 'Draft',
  live: 'Live',
  paused: 'Paused',
  needs_you: 'Needs you',
  error: 'Error',
};

/** Client mirror of the PATCH transitions in apps/client/server/utils/loopValidation.ts (nextStatusPatch). */
export const canSetLive = (status: LoopStatus) => status !== 'live';
// Pausing a scheduler pause (`autoResume`) turns it into an owner pause.
export const canPause = (loop: Pick<ILoop, 'status' | 'autoResume'>) =>
  loop.status === 'live' || (loop.status === 'paused' && !!loop.autoResume);
export const canRunNow = (status: LoopStatus) => status === 'live';

export function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return `every ${minutes / 1440} ${minutes === 1440 ? 'day' : 'days'}`;
  if (minutes % 60 === 0) return `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

export const lastRunLabel = (loop: Pick<ILoop, 'lastRunAt'>) =>
  loop.lastRunAt ? relativeTimeFormat(loop.lastRunAt) : 'never';

export function nextRunLabel(loop: Pick<ILoop, 'status' | 'nextRunAt' | 'activeExecutionIds'>): string {
  if (activeLaneCount(loop) > 0) return 'running';
  if (loop.status !== 'live' || !loop.nextRunAt) return '-';
  return new Date(loop.nextRunAt).getTime() <= Date.now() ? 'due' : relativeTimeFormat(loop.nextRunAt);
}

/**
 * Why a live loop runs less often: after idle runs in a row the scheduler doubles its wait
 * (apps/workers/src/cron/loopScheduler.ts, backoffMinutes). Null when it is not backing off.
 */
export function backoffLabel(
  loop: Pick<ILoop, 'status' | 'idleStreak' | 'nextRunAt' | 'activeExecutionIds'>,
  now = Date.now()
): string | null {
  if (loop.status !== 'live' || !loop.idleStreak || !loop.nextRunAt || activeLaneCount(loop) > 0) return null;
  const minutes = Math.max(0, Math.round((new Date(loop.nextRunAt).getTime() - now) / 60_000));
  const runs = loop.idleStreak === 1 ? 'run' : `${loop.idleStreak} runs`;
  return `Backing off: next run in ${minutes} min, nothing changed in the last ${runs}`;
}

const CAPACITY_LABELS: Record<LoopCapacityLimit, (loop: Pick<ILoop, 'maxConcurrent'>) => string> = {
  loop: loop => `All ${loopMaxConcurrent(loop)} run lanes busy (loop lane limit)`,
  user: () => 'Waiting for a free run slot (your cloud run limit)',
  server: () => 'Waiting for a free run slot (server-wide limit)',
  budget: () => "Waiting for budget: running lanes have reserved the rest of today's budget",
};

const HOLD_LABELS: Record<LoopHoldKind, (hold: ILoopHold, loop: Pick<ILoop, 'maxConcurrent'>) => string> = {
  pacing: hold =>
    `Paced: next run at ${new Date(hold.until!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to spread the daily budget`,
  // A capacity hold from before lanes has no limit; it was the server-wide one.
  capacity: (hold, loop) => CAPACITY_LABELS[hold.limit ?? 'server'](loop),
};

/**
 * Why a live loop is held back on purpose: the scheduler's pacing or run-cap hold (`ILoop.hold`, set in
 * apps/workers/src/cron/loopScheduler.ts), else its idle back-off. Null when nothing holds it.
 */
export function holdLabel(
  loop: Pick<ILoop, 'status' | 'idleStreak' | 'nextRunAt' | 'activeExecutionIds' | 'hold' | 'maxConcurrent'>,
  now = Date.now()
): string | null {
  if (loop.status !== 'live') return null;
  const { hold } = loop;
  // A pacing hold lapses once its deferred run is due. A hold shows beside running lanes: it holds the free ones.
  if (hold && (hold.kind !== 'pacing' || (hold.until && new Date(hold.until).getTime() > now))) {
    return HOLD_LABELS[hold.kind](hold, loop);
  }
  return backoffLabel(loop, now);
}

/** The owner rule the inbox notice sweep uses (`loopStatusNeedsOwner`), plus blocked tickets and liveness alarms. */
export const loopNeedsOwner = (loop: Pick<ILoopWithUsage, 'status' | 'statusReason' | 'blockedTickets' | 'alarm'>) =>
  loopStatusNeedsOwner(loop) || loop.blockedTickets > 0 || !!loop.alarm;

export const formatCredits = (credits: number) => `${Math.round(credits).toLocaleString()} credits`;

export const formatSpendToday = (loop: Pick<ILoopWithUsage, 'creditsToday' | 'budgetCreditsPerDay'>) =>
  loop.budgetCreditsPerDay === undefined
    ? formatCredits(loop.creditsToday)
    : `${Math.round(loop.creditsToday).toLocaleString()} / ${loop.budgetCreditsPerDay.toLocaleString()} credits`;

export function LoopStatusChip({ loop }: { loop: Pick<ILoop, 'status' | 'statusReason' | 'alarm'> }) {
  return (
    <Stack sx={{ alignItems: 'flex-start', gap: 0.25 }}>
      <Chip size="sm" variant="soft" color={STATUS_COLOR[loop.status]} data-testid="loop-status-chip">
        {STATUS_LABEL[loop.status]}
      </Chip>
      {loop.statusReason && (
        <Typography level="body-xs" color={STATUS_COLOR[loop.status]} data-testid="loop-status-reason">
          {loop.statusReason}
        </Typography>
      )}
      {loop.alarm && (
        <Typography level="body-xs" color="warning" data-testid="loop-alarm-reason">
          {loop.alarm.reason}
        </Typography>
      )}
    </Stack>
  );
}

/** The loop's tools the server cannot run (missing key or config); runs skip them. MCP tools are never listed. */
export const unavailableTools = (tools: readonly string[], availability: ToolAvailability | undefined) =>
  tools.filter(tool => isToolKeyMissing(tool as B4MLLMTools, availability));

export const unavailableToolsMessage = (names: string[]) =>
  `${names.join(', ')} ${names.length === 1 ? "isn't" : "aren't"} available on this server, so runs skip ${
    names.length === 1 ? 'it' : 'them'
  }.`;

const MarkdownLink = link;
const markdownComponents = {
  ...createMarkdownComponents({ highlightText: node => node }),
  a: link,
  // Chat's paragraph carries the chat reply testid.
  p: ({ node, ...props }: ComponentProps<'p'> & ExtraProps) => <p {...props} />,
  // Model-written loop text can come from untrusted pages; a remote image would load on view, so link it instead.
  img: ({ src, alt }: ComponentProps<'img'>) => {
    const href = typeof src === 'string' ? src : undefined;
    return <MarkdownLink href={href}>{alt || href}</MarkdownLink>;
  },
};

/**
 * Model-written loop text (questions, directive threads, ticket reasons, memory) rendered with chat's markdown
 * components. No rehype-raw, so raw HTML in the text stays escaped.
 */
export function LoopMarkdown({
  children,
  testId,
  level = 'body-sm',
}: {
  children: string;
  testId?: string;
  level?: 'body-sm' | 'body-xs';
}) {
  return (
    <Box
      data-testid={testId}
      sx={{
        typography: level,
        color: 'inherit',
        overflowWrap: 'anywhere',
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p, & ul, & ol': { my: 0.5 },
        '& ul, & ol': { pl: 2.5 },
        '& h1, & h2, & h3, & h4': { fontSize: 'inherit', my: 0.5 },
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </Box>
  );
}
