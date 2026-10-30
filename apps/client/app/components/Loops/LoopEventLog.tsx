import { useState } from 'react';
import { Button, Chip, Input, Stack, Typography, type ColorPaletteProp } from '@mui/joy';
import type { LoopDirectiveOwnerAction, LoopDirectiveState } from '@bike4mind/common';
import type { ILoopDirectiveRow, ILoopEventRow, ILoopUnsureRow } from '@client/app/hooks/data/loops';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';

export type OnOverrideDirective = (eventId: string, action: LoopDirectiveOwnerAction, note?: string) => void;

interface LoopEventLogProps {
  data?: ILoopEventRow[];
  onViewRun: (executionId: string) => void;
  /** The loop whose log this is: a directive it sent reads "To <worker>", one it received "From <overseer>". */
  loopId?: string;
  /** The owner's loops, to name a directive's worker. */
  loops?: { id: string; name: string }[];
  onOverride?: OnOverrideDirective;
}

const DIRECTIVE_STATE: Record<LoopDirectiveState, { label: string; color: ColorPaletteProp }> = {
  open: { label: 'Open', color: 'primary' },
  accepted: { label: 'Accepted', color: 'success' },
  pushed_back: { label: 'Pushed back', color: 'warning' },
  done: { label: 'Done', color: 'neutral' },
  withdrawn: { label: 'Withdrawn', color: 'neutral' },
};

const REPLY_LABEL: Record<ILoopDirectiveRow['replies'][number]['outcome'], string> = {
  accepted: 'accepted',
  pushed_back: 'pushed back',
  done: 'marked done',
  withdrawn: 'withdrew',
  overruled: 'overruled',
};

const RESOLUTION: Record<'open' | 'resumed' | 'rejected', { label: string; color: ColorPaletteProp }> = {
  open: { label: 'Needs you', color: 'warning' },
  resumed: { label: 'Resumed', color: 'success' },
  rejected: { label: 'Rejected', color: 'neutral' },
};

/** A loop's event log, newest first. One row renderer per event kind. */
export default function LoopEventLog({ data, onViewRun, loopId, loops, onOverride }: LoopEventLogProps) {
  if (!data) return null;
  if (data.length === 0) {
    return (
      <Typography level="body-sm" data-testid="loop-log-empty">
        Nothing yet. A run that is unsure how to go on pauses here for you, and directives between loops show here.
      </Typography>
    );
  }
  return (
    <Stack gap={1} data-testid="loop-log">
      {data.map(event => {
        switch (event.kind) {
          case 'unsure':
            return <UnsureRow key={event.id} event={event} onViewRun={onViewRun} />;
          case 'directive':
            return (
              <DirectiveRow
                key={event.id}
                event={event}
                onViewRun={onViewRun}
                loopId={loopId}
                loops={loops}
                onOverride={onOverride}
              />
            );
          default:
            return null;
        }
      })}
    </Stack>
  );
}

function UnsureRow({ event, onViewRun }: { event: ILoopUnsureRow; onViewRun: (executionId: string) => void }) {
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
            Unsure ({Math.round(event.confidence * 100)}% confidence) - {relativeTimeFormat(new Date(event.createdAt))}
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

function DirectiveRow({
  event,
  onViewRun,
  loopId,
  loops,
  onOverride,
}: Omit<LoopEventLogProps, 'data'> & { event: ILoopDirectiveRow }) {
  const [pending, setPending] = useState<LoopDirectiveOwnerAction | null>(null);
  const [note, setNote] = useState('');
  const state = DIRECTIVE_STATE[event.state];
  const direction =
    event.fromLoopId === loopId
      ? `To ${loops?.find(loop => loop.id === event.loopId)?.name ?? 'a deleted loop'}`
      : `From ${event.fromLoopName}`;
  const canWithdraw = ['open', 'accepted', 'pushed_back'].includes(event.state);
  const canOverrule = event.state === 'pushed_back';

  const confirm = () => {
    if (pending) onOverride?.(event.id, pending, note.trim() || undefined);
    setPending(null);
    setNote('');
  };

  return (
    <Stack gap={0.5} data-testid="loop-log-directive-row">
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <Typography level="title-sm" data-testid="loop-log-directive-direction">
          Directive - {direction}
        </Typography>
        <Chip size="sm" variant="soft" color={state.color} data-testid="loop-log-directive-state">
          {state.label}
        </Chip>
        <Typography level="body-xs">{relativeTimeFormat(new Date(event.createdAt))}</Typography>
      </Stack>
      <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
        {event.instruction}
      </Typography>
      <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap' }}>
        Why: {event.reason}
      </Typography>
      {event.replies.map((reply, index) => (
        <Stack
          key={index}
          direction="row"
          gap={1}
          alignItems="baseline"
          sx={{ pl: 2 }}
          data-testid="loop-log-directive-reply"
        >
          <Typography level="body-xs" sx={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap' }}>
            {reply.by === 'owner' ? 'You' : 'Worker'} {REPLY_LABEL[reply.outcome]}
            {reply.note ? `: ${reply.note}` : ''} - {relativeTimeFormat(new Date(reply.at))}
          </Typography>
          {reply.by === 'worker' && reply.executionId && (
            <Button size="sm" variant="plain" onClick={() => onViewRun(reply.executionId!)}>
              View run
            </Button>
          )}
        </Stack>
      ))}
      {onOverride && pending ? (
        <Stack direction="row" gap={1} alignItems="center">
          <Input
            size="sm"
            sx={{ flex: 1 }}
            placeholder="Note (optional)"
            value={note}
            onChange={e => setNote(e.target.value)}
            slotProps={{ input: { maxLength: 1000, 'data-testid': 'loop-log-directive-note-input' } }}
          />
          <Button size="sm" onClick={confirm} data-testid="loop-log-directive-confirm-btn">
            {pending === 'withdraw' ? 'Withdraw' : 'Overrule'}
          </Button>
          <Button size="sm" variant="plain" color="neutral" onClick={() => setPending(null)}>
            Cancel
          </Button>
        </Stack>
      ) : (
        onOverride &&
        (canWithdraw || canOverrule) && (
          <Stack direction="row" gap={1}>
            {canWithdraw && (
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => setPending('withdraw')}
                data-testid="loop-log-directive-withdraw-btn"
              >
                Withdraw
              </Button>
            )}
            {canOverrule && (
              <Button
                size="sm"
                variant="outlined"
                color="warning"
                onClick={() => setPending('overrule')}
                data-testid="loop-log-directive-overrule-btn"
              >
                Overrule
              </Button>
            )}
          </Stack>
        )
      )}
    </Stack>
  );
}
