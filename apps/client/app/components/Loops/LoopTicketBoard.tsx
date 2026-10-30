import { useState } from 'react';
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
import type { ILoop, WorkItemStatus } from '@bike4mind/common';
import {
  useCreateLoopTicket,
  useMoveLoopTicket,
  type ILoopTicket,
  type ILoopTicketsResponse,
} from '@client/app/hooks/data/loops';

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

function TicketCard({
  ticket,
  stages,
  onViewRun,
}: {
  ticket: ILoopTicket;
  stages: string[];
  onViewRun: (executionId: string) => void;
}) {
  const moveTicket = useMoveLoopTicket();
  return (
    <Card size="sm" variant="outlined" data-testid={`loop-ticket-${ticket.id}`}>
      <Typography level="title-sm">{ticket.title}</Typography>
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <Chip size="sm" variant="soft" color={STATUS_COLOR[ticket.status]}>
          {STATUS_LABEL[ticket.status]}
        </Chip>
        {ticket.dependencies.length > 0 && (
          <Typography level="body-xs">
            {ticket.dependencies.length} {ticket.dependencies.length === 1 ? 'dep' : 'deps'}
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
      {ticket.status === 'blocked' && ticket.statusReason && (
        <Typography level="body-xs" color="danger" data-testid="loop-ticket-blocked-reason">
          {ticket.statusReason}
        </Typography>
      )}
      <Select
        size="sm"
        value={ticket.stage ?? null}
        disabled={moveTicket.isPending || ticket.status === 'in_progress'}
        onChange={(_, stage) => stage && stage !== ticket.stage && moveTicket.mutate({ id: ticket.id, stage })}
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
    </Card>
  );
}

function AddTicketModal({ loop, onClose }: { loop: ILoop; onClose: () => void }) {
  const createTicket = useCreateLoopTicket();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState(loop.stages[0]);
  const [error, setError] = useState<string>();

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > TITLE_MAX) {
      setError(`Title must be 1 to ${TITLE_MAX} characters`);
      return;
    }
    setError(undefined);
    createTicket.mutate(
      { loopId: loop.id, title: trimmed, ...(description.trim() && { description: description.trim() }), stage },
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
  const all = data?.stages.flatMap(group => group.tickets) ?? [];
  // Same order the scheduler picks in (WorkItemModel.findNextReadyForLoop): oldest created first.
  const ready = all.filter(t => t.ready).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

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
            <Typography level="title-sm">
              {group.stage} ({group.tickets.length})
            </Typography>
            {group.tickets.map(ticket => (
              <TicketCard key={ticket.id} ticket={ticket} stages={loop.stages} onViewRun={onViewRun} />
            ))}
          </Stack>
        ))}
      </Box>
      {adding && <AddTicketModal loop={loop} onClose={() => setAdding(false)} />}
    </Stack>
  );
}
