import { Chip, Stack, Typography, type ColorPaletteProp } from '@mui/joy';
import { loopStatusNeedsOwner, type ILoop, type ILoopWithUsage, type LoopStatus } from '@bike4mind/common';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';

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
export const canPause = (status: LoopStatus) => status === 'live';
export const canRunNow = (status: LoopStatus) => status === 'live';

export function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return `every ${minutes / 1440} ${minutes === 1440 ? 'day' : 'days'}`;
  if (minutes % 60 === 0) return `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

export const lastRunLabel = (loop: Pick<ILoop, 'lastRunAt'>) =>
  loop.lastRunAt ? relativeTimeFormat(loop.lastRunAt) : 'never';

export function nextRunLabel(loop: Pick<ILoop, 'status' | 'nextRunAt' | 'activeExecutionId'>): string {
  if (loop.activeExecutionId) return 'running';
  if (loop.status !== 'live' || !loop.nextRunAt) return '-';
  return new Date(loop.nextRunAt).getTime() <= Date.now() ? 'due' : relativeTimeFormat(loop.nextRunAt);
}

/** The owner rule the inbox notice sweep uses (`loopStatusNeedsOwner`), plus blocked tickets. */
export const loopNeedsOwner = (loop: Pick<ILoopWithUsage, 'status' | 'statusReason' | 'blockedTickets'>) =>
  loopStatusNeedsOwner(loop) || loop.blockedTickets > 0;

export const formatCredits = (credits: number) => `${Math.round(credits).toLocaleString()} credits`;

export function LoopStatusChip({ loop }: { loop: Pick<ILoop, 'status' | 'statusReason'> }) {
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
    </Stack>
  );
}
