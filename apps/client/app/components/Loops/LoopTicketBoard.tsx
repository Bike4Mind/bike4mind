import { useState } from 'react';
import { useMutationState } from '@tanstack/react-query';
import {
  Box,
  Button,
  Card,
  Chip,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Link,
  Modal,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Textarea,
  Typography,
  type ColorPaletteProp,
} from '@mui/joy';
import {
  desktopStagesOf,
  LOOP_SERVICE_LEVEL_HOURS,
  WORK_ITEM_PRIORITIES,
  workItemPriorityRank,
  type ILoop,
  type WorkItemPriority,
  type WorkItemStatus,
} from '@bike4mind/common';
import {
  MOVE_LOOP_TICKET_KEY,
  useCreateLoopTicket,
  useMoveLoopTicket,
  type ILoopTicket,
  type MoveLoopTicketVars,
  type ILoopTicketsResponse,
} from '@client/app/hooks/data/loops';
import { LoopMarkdown } from './loopUi';

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 10_000;

const STATUS_COLOR: Record<WorkItemStatus, ColorPaletteProp> = {
  open: 'neutral',
  in_progress: 'primary',
  blocked: 'danger',
  closed: 'success',
};

const STATUS_LABEL: Record<WorkItemStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Done',
};

const PRIORITY_CHIP: Record<WorkItemPriority, { color: ColorPaletteProp; variant: 'soft' | 'outlined' }> = {
  p0: { color: 'danger', variant: 'soft' },
  p1: { color: 'warning', variant: 'soft' },
  p2: { color: 'neutral', variant: 'soft' },
  p3: { color: 'neutral', variant: 'outlined' },
};

/** Untriaged tickets sort after p3: the scheduler picks none of them until a triage run sets a priority. */
const rankOf = (ticket: ILoopTicket) =>
  ticket.priority ? workItemPriorityRank(ticket.priority) : WORK_ITEM_PRIORITIES.length;

const byPriorityThenAge = (a: ILoopTicket, b: ILoopTicket) =>
  rankOf(a) - rankOf(b) || a.createdAt.localeCompare(b.createdAt);

/** The add modal's priority choice: none leaves the ticket to the loop's triage run. */
const TRIAGE = 'triage';

function TicketCard({
  loopId,
  ticket,
  loop,
  stages,
  desktop,
  runner,
  runLimit,
  onViewRun,
}: {
  loopId: string;
  ticket: ILoopTicket;
  loop: Pick<ILoop, 'serviceLevelHours'>;
  stages: string[];
  /** The ticket's stage is worked by a desktop runner, never by a cloud run. */
  desktop: boolean;
  runner?: ILoopTicketsResponse['runner'];
  runLimit?: number;
  onViewRun: (executionId: string) => void;
}) {
  const moveTicket = useMoveLoopTicket();
  // Only this card locks while its own move saves; the rest of the board stays usable.
  const saving = useMutationState({
    filters: { mutationKey: MOVE_LOOP_TICKET_KEY, status: 'pending' },
    select: mutation => (mutation.state.variables as MoveLoopTicketVars).id,
  }).includes(ticket.id);
  return (
    <Card size="sm" variant="outlined" data-testid={`loop-ticket-${ticket.id}`}>
      <Typography level="title-sm">{ticket.title}</Typography>
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        {ticket.priority ? (
          <Chip size="sm" {...PRIORITY_CHIP[ticket.priority]} data-testid="loop-ticket-priority-chip">
            {ticket.priority.toUpperCase()}
          </Chip>
        ) : (
          !ticket.epic && (
            <Chip
              size="sm"
              variant="outlined"
              color="neutral"
              title="The loop's next triage run sets its priority"
              data-testid="loop-ticket-untriaged"
            >
              Untriaged
            </Chip>
          )
        )}
        {ticket.demoted && (
          <Chip
            size="sm"
            variant="outlined"
            color="neutral"
            title="Moved to p3 by the loop's p2 runs per day; set a priority to keep it"
            data-testid="loop-ticket-demoted"
          >
            Demoted
          </Chip>
        )}
        {ticket.stale && ticket.priority && ticket.priority in LOOP_SERVICE_LEVEL_HOURS && (
          <Chip
            size="sm"
            variant="soft"
            color="warning"
            title={`Waiting past its ${
              loop.serviceLevelHours?.[ticket.priority as 'p0' | 'p1'] ??
              LOOP_SERVICE_LEVEL_HOURS[ticket.priority as 'p0' | 'p1']
            }h service level`}
            data-testid="loop-ticket-stale"
          >
            Overdue
          </Chip>
        )}
        {ticket.epic && (
          <Chip size="sm" variant="soft" color="neutral" data-testid="loop-ticket-epic">
            Epic: {ticket.childrenDone ?? 0}/{ticket.dependencies.length} children done
          </Chip>
        )}
        <Chip size="sm" variant="soft" color={STATUS_COLOR[ticket.status]}>
          {STATUS_LABEL[ticket.status]}
        </Chip>
        {ticket.status === 'blocked' && ticket.blockedOn === 'dependencies' && !ticket.epic && (
          <Chip size="sm" variant="outlined" color="neutral" data-testid="loop-ticket-waiting-deps">
            Waiting on dependencies
          </Chip>
        )}
        {desktop && ticket.status === 'open' && (
          <Chip
            size="sm"
            variant="outlined"
            color="neutral"
            title={runner?.online ? runner.waitingReason : undefined}
            data-testid="loop-ticket-waiting-desktop"
          >
            {runner?.online ? 'Queued for desktop' : 'Waiting on: desktop offline'}
          </Chip>
        )}
        {ticket.dependencies.length > 0 && (
          <Typography level="body-xs">
            {ticket.dependencies.length} {ticket.dependencies.length === 1 ? 'dep' : 'deps'}
          </Typography>
        )}
        {ticket.runCount > 0 && runLimit !== undefined && (
          <Typography level="body-xs" data-testid="loop-ticket-run-count">
            Run {ticket.runCount} of {runLimit}
          </Typography>
        )}
        {ticket.executionId && (
          <Link
            component="button"
            level="body-xs"
            onClick={() => onViewRun(ticket.executionId!)}
            data-testid="loop-ticket-view-run-link"
          >
            View run
          </Link>
        )}
      </Stack>
      {ticket.status === 'blocked' && !ticket.blockedOn && ticket.statusReason && (
        <Typography level="body-xs" color="danger" component="div">
          <LoopMarkdown level="body-xs" testId="loop-ticket-blocked-reason">
            {ticket.statusReason}
          </LoopMarkdown>
        </Typography>
      )}
      <Stack direction="row" gap={1}>
        <Select
          size="sm"
          value={ticket.stage ?? null}
          disabled={saving || ticket.status === 'in_progress'}
          onChange={(_, stage) =>
            stage && stage !== ticket.stage && moveTicket.mutate({ loopId, id: ticket.id, stage })
          }
          sx={{ flex: 1 }}
          data-testid="loop-ticket-stage-select"
        >
          {/* A stage removed from the loop still labels its tickets; the API groups them under the first stage. */}
          {ticket.stage && !stages.includes(ticket.stage) && (
            <Option value={ticket.stage} disabled>
              {ticket.stage} (removed)
            </Option>
          )}
          {stages.map(stage => (
            <Option key={stage} value={stage}>
              {stage}
            </Option>
          ))}
        </Select>
        <Select
          size="sm"
          value={ticket.priority ?? null}
          placeholder="Triage"
          disabled={saving || ticket.status === 'in_progress' || ticket.epic}
          onChange={(_, priority) =>
            priority && priority !== ticket.priority && moveTicket.mutate({ loopId, id: ticket.id, priority })
          }
          data-testid="loop-ticket-priority-select"
        >
          {WORK_ITEM_PRIORITIES.map(priority => (
            <Option key={priority} value={priority}>
              {priority.toUpperCase()}
            </Option>
          ))}
        </Select>
      </Stack>
    </Card>
  );
}

function AddTicketModal({ loop, onClose }: { loop: ILoop; onClose: () => void }) {
  const createTicket = useCreateLoopTicket();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState(loop.stages[0]);
  const [priority, setPriority] = useState<WorkItemPriority | typeof TRIAGE>(TRIAGE);
  const [error, setError] = useState<string>();

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > TITLE_MAX) {
      setError(`Title must be 1 to ${TITLE_MAX} characters`);
      return;
    }
    setError(undefined);
    createTicket.mutate(
      {
        loopId: loop.id,
        title: trimmed,
        ...(description.trim() && { description: description.trim() }),
        stage,
        ...(priority !== TRIAGE && { priority }),
      },
      { onSuccess: onClose }
    );
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: 480, maxWidth: '95vw' }}>
        <DialogTitle>Add ticket</DialogTitle>
        <Stack gap={2}>
          <FormControl error={!!error}>
            <FormLabel>Title</FormLabel>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              slotProps={{ input: { 'data-testid': 'loop-ticket-title-input' } }}
            />
            {error && <FormHelperText>{error}</FormHelperText>}
          </FormControl>
          <FormControl>
            <FormLabel>Description</FormLabel>
            <Textarea
              minRows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              slotProps={{ textarea: { maxLength: DESCRIPTION_MAX, 'data-testid': 'loop-ticket-description-input' } }}
            />
          </FormControl>
          <FormControl>
            <FormLabel>Stage</FormLabel>
            <Select value={stage} onChange={(_, s) => s && setStage(s)} data-testid="loop-ticket-stage-select-new">
              {loop.stages.map(s => (
                <Option key={s} value={s}>
                  {s}
                </Option>
              ))}
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel>Priority</FormLabel>
            <Select
              value={priority}
              onChange={(_, p) => p && setPriority(p)}
              data-testid="loop-ticket-priority-select-new"
            >
              <Option value={TRIAGE}>Triage</Option>
              {WORK_ITEM_PRIORITIES.map(p => (
                <Option key={p} value={p}>
                  {p.toUpperCase()}
                </Option>
              ))}
            </Select>
          </FormControl>
          <Stack direction="row" gap={1} justifyContent="flex-end">
            <Button variant="plain" color="neutral" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} loading={createTicket.isPending} data-testid="loop-ticket-submit-btn">
              Add
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

function Strip({ label, testId, tickets }: { label: string; testId: string; tickets: ILoopTicket[] }) {
  return (
    <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm', flex: 1, minWidth: 200 }} data-testid={testId}>
      <Typography level="title-sm">
        {label} ({tickets.length})
      </Typography>
      {tickets.map(ticket => (
        <Typography key={ticket.id} level="body-xs" noWrap>
          {ticket.title}
          {ticket.status === 'blocked' && ticket.statusReason ? ` - ${ticket.statusReason}` : ''}
        </Typography>
      ))}
    </Sheet>
  );
}

/**
 * The loop's tickets: a queued / in progress / blocked summary over one column per stage.
 * `onViewRun` opens a ticket's run (the loop page's live run drawer).
 */
export default function LoopTicketBoard({
  loop,
  data,
  onViewRun,
}: {
  loop: ILoop;
  data?: ILoopTicketsResponse;
  onViewRun: (executionId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const desktopStages = new Set(desktopStagesOf(loop));
  const all = data?.stages.flatMap(group => group.tickets) ?? [];
  // Same order the scheduler picks in (WorkItemModel.listReadyForLoop): priority, furthest stage, then oldest.
  const stageIndex = (t: ILoopTicket) => loop.stages.indexOf(t.stage ?? '');
  const ready = all
    .filter(t => t.ready)
    .sort((a, b) => rankOf(a) - rankOf(b) || stageIndex(b) - stageIndex(a) || a.createdAt.localeCompare(b.createdAt));

  return (
    <Stack gap={2}>
      <Stack direction="row" gap={1} flexWrap="wrap">
        <Strip label="Queued" testId="loop-ticket-strip-ready" tickets={ready} />
        <Strip
          label="In progress"
          testId="loop-ticket-strip-in-progress"
          tickets={all.filter(t => t.status === 'in_progress')}
        />
        <Strip label="Blocked" testId="loop-ticket-strip-blocked" tickets={all.filter(t => t.status === 'blocked')} />
      </Stack>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography level="title-md">Tickets</Typography>
        <Button size="sm" variant="outlined" onClick={() => setAdding(true)} data-testid="loop-ticket-add-btn">
          Add ticket
        </Button>
      </Stack>
      <Box sx={{ display: 'flex', gap: 1.5, overflowX: 'auto', pb: 1 }}>
        {(data?.stages ?? loop.stages.map(stage => ({ stage, tickets: [] }))).map(group => (
          <Stack
            key={group.stage}
            gap={1}
            sx={{ minWidth: 260, width: 260, flexShrink: 0 }}
            data-testid={`loop-stage-column-${group.stage}`}
          >
            <Stack direction="row" gap={1} alignItems="center">
              <Typography level="title-sm">
                {group.stage} ({group.tickets.length})
              </Typography>
              {desktopStages.has(group.stage) && (
                <Chip size="sm" variant="soft" data-testid={`loop-board-stage-desktop-${group.stage}`}>
                  Desktop
                </Chip>
              )}
            </Stack>
            {[
              ...group.tickets.filter(t => t.status !== 'closed').sort(byPriorityThenAge),
              ...group.tickets.filter(t => t.status === 'closed'),
            ].map(ticket => (
              <TicketCard
                key={ticket.id}
                loopId={loop.id}
                ticket={ticket}
                loop={loop}
                stages={loop.stages}
                desktop={!!ticket.stage && desktopStages.has(ticket.stage)}
                runner={data?.runner}
                runLimit={data?.runLimit}
                onViewRun={onViewRun}
              />
            ))}
          </Stack>
        ))}
      </Box>
      {adding && <AddTicketModal loop={loop} onClose={() => setAdding(false)} />}
    </Stack>
  );
}
