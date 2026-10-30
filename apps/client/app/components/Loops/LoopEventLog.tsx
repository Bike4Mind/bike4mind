import { Button, Chip, Stack, Typography, type ColorPaletteProp } from '@mui/joy';
import type { ILoopEventRow } from '@client/app/hooks/data/loops';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';

interface LoopEventLogProps {
  data?: ILoopEventRow[];
  onViewRun: (executionId: string) => void;
}

const RESOLUTION: Record<'open' | 'resumed' | 'rejected', { label: string; color: ColorPaletteProp }> = {
  open: { label: 'Needs you', color: 'warning' },
  resumed: { label: 'Resumed', color: 'success' },
  rejected: { label: 'Rejected', color: 'neutral' },
};

/** A loop's event log, newest first. One row renderer per event kind. */
export default function LoopEventLog({ data, onViewRun }: LoopEventLogProps) {
  if (!data) return null;
  if (data.length === 0) {
    return (
      <Typography level="body-sm" data-testid="loop-log-empty">
        Nothing yet. A run that is unsure how to go on pauses here for you.
      </Typography>
    );
  }
  return (
    <Stack gap={1} data-testid="loop-log">
      {data.map(event => {
        switch (event.kind) {
          case 'unsure':
            return <UnsureRow key={event.id} event={event} onViewRun={onViewRun} />;
          case 'auto_resumed':
            return <AutoResumedRow key={event.id} event={event} onViewRun={onViewRun} />;
          default:
            return null;
        }
      })}
    </Stack>
  );
}

function UnsureRow({ event, onViewRun }: { event: ILoopEventRow; onViewRun: (executionId: string) => void }) {
  const resolution = RESOLUTION[event.resolution?.outcome ?? 'open'];
  return (
    <Stack direction="row" gap={1.5} alignItems="flex-start" data-testid="loop-log-row">
      <Stack sx={{ flex: 1, minWidth: 0 }} gap={0.25}>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <Typography level="title-sm">{event.ticketTitle ?? 'Goal run'}</Typography>
          <Chip size="sm" variant="soft" color={resolution.color} data-testid="loop-log-resolution">
            {resolution.label}
          </Chip>
          <Typography level="body-xs">
            Unsure ({Math.round((event.confidence ?? 0) * 100)}% confidence) -{' '}
            {relativeTimeFormat(new Date(event.createdAt))}
          </Typography>
        </Stack>
        <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
          {event.reason}
        </Typography>
      </Stack>
      <Button
        size="sm"
        variant="plain"
        onClick={() => onViewRun(event.executionId)}
        data-testid="loop-log-view-run-btn"
      >
        View run
      </Button>
    </Stack>
  );
}

function AutoResumedRow({ event, onViewRun }: { event: ILoopEventRow; onViewRun: (executionId: string) => void }) {
  return (
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" data-testid="loop-log-row">
      <Chip size="sm" variant="soft" color="success" data-testid="loop-log-resolution">
        Auto-resumed
      </Chip>
      <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }}>
        {event.reason} - {relativeTimeFormat(new Date(event.createdAt))}
      </Typography>
      <Button
        size="sm"
        variant="plain"
        onClick={() => onViewRun(event.executionId)}
        data-testid="loop-log-view-run-btn"
      >
        View run
      </Button>
    </Stack>
  );
}
