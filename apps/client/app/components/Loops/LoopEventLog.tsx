import { useState } from 'react';
import { Box, Button, Chip, Input, Stack, Textarea, Typography, type ColorPaletteProp } from '@mui/joy';
import {
  LOOP_DIRECTIVE_NOTE_MAX,
  LOOP_DIRECTIVE_TRANSITIONS,
  type LoopDirectiveOwnerAction,
  type LoopDirectiveState,
  type LoopGateOutcome,
} from '@bike4mind/common';
import type { ILoopDirectiveRow, ILoopEventRow, ILoopUnsureRow } from '@client/app/hooks/data/loops';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { LoopMarkdown } from './loopUi';

export type OnOverrideDirective = (eventId: string, action: LoopDirectiveOwnerAction, note?: string) => void;
/** Answers a question a run asked with loop_ticket_unsure; `note` (the answer) is required to resume. */
export type OnResolveUnsure = (eventId: string, outcome: LoopGateOutcome, note?: string) => void;

interface LoopEventLogProps {
  data?: ILoopEventRow[];
  onViewRun: (executionId: string) => void;
  /** The loop whose log this is: a directive it sent reads "To <worker>", one it received "From <overseer>". */
  loopId?: string;
  /** The owner's loops, to name a directive's worker. */
  loops?: { id: string; name: string }[];
  onOverride?: OnOverrideDirective;
  onResolveUnsure?: OnResolveUnsure;
}

const DIRECTIVE_STATE: Record<LoopDirectiveState, { label: string; color: ColorPaletteProp }> = {
  open: { label: 'Open', color: 'primary' },
  accepted: { label: 'Accepted', color: 'success' },
  pushed_back: { label: 'Pushed back', color: 'warning' },
  done: { label: 'Done', color: 'neutral' },
  withdrawn: { label: 'Withdrawn', color: 'neutral' },
};

// The directive is back to open, but until the worker answers again it reads as the owner's overrule.
const OVERRULED = { label: 'Overruled', color: 'warning' } as const;

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
export default function LoopEventLog({
  data,
  onViewRun,
  loopId,
  loops,
  onOverride,
  onResolveUnsure,
}: LoopEventLogProps) {
  if (!data) return null;
  if (data.length === 0) {
    return (
      <Typography level="body-sm" data-testid="loop-log-empty">
        Nothing yet. A run parks a ticket here when it asks you a question, or when its tools keep returning nothing
        useful. Directives between loops show here too.
      </Typography>
    );
  }
  return (
    <Stack gap={1} data-testid="loop-log">
      {data.map(event => {
        switch (event.kind) {
          case 'unsure':
            return <UnsureRow key={event.id} event={event} onViewRun={onViewRun} onResolve={onResolveUnsure} />;
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
          case 'auto_resumed':
            return <AutoResumedRow key={event.id} event={event} onViewRun={onViewRun} />;
          default:
            return null;
        }
      })}
    </Stack>
  );
}

function UnsureRow({
  event,
  onViewRun,
  onResolve,
}: {
  event: ILoopUnsureRow;
  onViewRun: (executionId: string) => void;
  onResolve?: OnResolveUnsure;
}) {
  const [answer, setAnswer] = useState('');
  const resolution = RESOLUTION[event.resolution?.outcome ?? 'open'];
  const asked = event.source === 'asked';
  const when = relativeTimeFormat(new Date(event.createdAt));
  return (
    <Stack direction="row" gap={1.5} alignItems="flex-start" data-testid="loop-log-row">
      <Stack sx={{ flex: 1, minWidth: 0 }} gap={0.25}>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <Typography level="title-sm">{event.ticketTitle ?? 'Goal run'}</Typography>
          <Chip size="sm" variant="soft" color={resolution.color} data-testid="loop-log-resolution">
            {resolution.label}
          </Chip>
          <Typography level="body-xs" data-testid="loop-log-unsure-subtitle">
            {asked
              ? `Asked you - ${when}`
              : `Unsure (${Math.round((event.confidence ?? 0) * 100)}% confidence) - ${when}`}
          </Typography>
        </Stack>
        <LoopMarkdown testId="loop-log-unsure-reason">{event.reason}</LoopMarkdown>
        {event.resolution?.note && (
          <Stack direction="row" gap={0.5} sx={{ pl: 2 }} data-testid="loop-log-unsure-answer">
            <Typography level="body-xs" sx={{ flexShrink: 0, pt: 0.25 }}>
              You:
            </Typography>
            <LoopMarkdown>{event.resolution.note}</LoopMarkdown>
          </Stack>
        )}
        {asked && !event.resolution && onResolve && (
          <Stack gap={0.5} sx={{ mt: 0.5 }}>
            <Textarea
              size="sm"
              minRows={2}
              placeholder="Your answer"
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              slotProps={{
                textarea: { maxLength: LOOP_DIRECTIVE_NOTE_MAX, 'data-testid': 'loop-log-unsure-answer-input' },
              }}
            />
            <Stack direction="row" gap={1}>
              <Button
                size="sm"
                disabled={!answer.trim()}
                onClick={() => onResolve(event.id, 'resumed', answer.trim())}
                data-testid="loop-log-unsure-resume-btn"
              >
                Resume
              </Button>
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => onResolve(event.id, 'rejected', answer.trim() || undefined)}
                data-testid="loop-log-unsure-reject-btn"
              >
                Reject
              </Button>
            </Stack>
          </Stack>
        )}
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
  const lastReply = event.replies.at(-1);
  const state =
    event.state === 'open' && lastReply?.by === 'owner' && lastReply.outcome === 'overruled'
      ? OVERRULED
      : DIRECTIVE_STATE[event.state];
  const direction =
    event.fromLoopId === loopId
      ? `To ${loops?.find(loop => loop.id === event.loopId)?.name ?? 'another loop'}`
      : `From ${event.fromLoopName}`;
  const canWithdraw = LOOP_DIRECTIVE_TRANSITIONS.withdraw.includes(event.state);
  const canOverrule = LOOP_DIRECTIVE_TRANSITIONS.overrule.includes(event.state);

  const close = () => {
    setPending(null);
    setNote('');
  };
  const confirm = () => {
    if (pending) onOverride?.(event.id, pending, note.trim() || undefined);
    close();
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
      <LoopMarkdown testId="loop-log-directive-instruction">{event.instruction}</LoopMarkdown>
      <Stack direction="row" gap={0.5}>
        <Typography level="body-xs" sx={{ flexShrink: 0, pt: 0.25 }}>
          Why:
        </Typography>
        <LoopMarkdown testId="loop-log-directive-reason">{event.reason}</LoopMarkdown>
      </Stack>
      {event.replies.map((reply, index) => (
        <Stack
          key={index}
          direction="row"
          gap={1}
          alignItems="baseline"
          sx={{ pl: 2 }}
          data-testid="loop-log-directive-reply"
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="body-xs">
              {reply.by === 'owner' ? 'You' : 'Worker'} {REPLY_LABEL[reply.outcome]} -{' '}
              {relativeTimeFormat(new Date(reply.at))}
            </Typography>
            {reply.note && <LoopMarkdown testId="loop-log-directive-reply-note">{reply.note}</LoopMarkdown>}
          </Box>
          {reply.by === 'worker' && reply.executionId && (
            <Button
              size="sm"
              variant="plain"
              onClick={() => onViewRun(reply.executionId!)}
              data-testid="loop-log-directive-view-run-btn"
            >
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
            slotProps={{
              input: { maxLength: LOOP_DIRECTIVE_NOTE_MAX, 'data-testid': 'loop-log-directive-note-input' },
            }}
          />
          <Button size="sm" onClick={confirm} data-testid="loop-log-directive-confirm-btn">
            {pending === 'withdraw' ? 'Withdraw' : 'Overrule'}
          </Button>
          <Button size="sm" variant="plain" color="neutral" onClick={close} data-testid="loop-log-directive-cancel-btn">
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
