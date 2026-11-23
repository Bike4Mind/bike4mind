import { useState } from 'react';
import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import FormControl from '@mui/joy/FormControl';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import type { LocalLoopDetail, LocalTicket } from '@shared/localLoops';
import type { TicketMove } from './LoopBoardView';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');

/** One ticket: edit title, description and dependencies; its stage history, runs and events; open a run's session. */
export function TicketDetail({
  ticket,
  detail,
  onSave,
  onOpenSession,
  onClose,
}: {
  ticket: LocalTicket;
  detail: LocalLoopDetail;
  onSave: (move: TicketMove) => Promise<boolean>;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description ?? '');
  const [dependencies, setDependencies] = useState(ticket.dependencies);
  const runs = detail.runs.filter(run => run.ticketId === ticket.id);
  const events = detail.events.filter(event => event.ticketId === ticket.id);
  const others = detail.tickets.filter(other => other.id !== ticket.id);

  const save = async () => {
    const changed: TicketMove = {
      ...(title.trim() !== ticket.title && { title: title.trim() }),
      ...(description !== (ticket.description ?? '') && { description }),
      ...(dependencies.join() !== ticket.dependencies.join() && { dependencies }),
    };
    if (Object.keys(changed).length === 0 || (await onSave(changed))) onClose();
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: 640, maxWidth: '95vw' }} data-testid="local-loops-ticket-detail">
        <DialogTitle>
          {ticket.title} ({ticket.stage}, {ticket.status})
        </DialogTitle>
        <DialogContent sx={{ overflowY: 'auto' }}>
          <Stack spacing={2}>
            {ticket.statusReason && <Typography level="body-sm">{ticket.statusReason}</Typography>}
            <FormControl>
              <FormLabel>Title</FormLabel>
              <Input size="sm" value={title} onChange={event => setTitle(event.target.value)} />
            </FormControl>
            <FormControl>
              <FormLabel>Description</FormLabel>
              <Textarea
                size="sm"
                minRows={3}
                value={description}
                onChange={event => setDescription(event.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Waits for</FormLabel>
              <Select
                size="sm"
                multiple
                value={dependencies}
                onChange={(_event, ids) => setDependencies(ids)}
                placeholder="No other ticket"
              >
                {others.map(other => (
                  <Option key={other.id} value={other.id}>
                    {other.title}
                  </Option>
                ))}
              </Select>
            </FormControl>

            <Typography level="title-sm">Stage history</Typography>
            {ticket.stageHistory.map((entry, i) => (
              <Typography key={i} level="body-xs">
                {when(entry.at)}: {entry.stage} (by {entry.by})
              </Typography>
            ))}

            <Typography level="title-sm">Runs</Typography>
            {runs.length === 0 && <Typography level="body-xs">No runs yet.</Typography>}
            {runs.map(run => (
              <Stack key={run.id} direction="row" spacing={1} alignItems="center" data-testid="local-loops-ticket-run">
                <Typography level="body-xs" sx={{ flex: 1 }}>
                  {when(run.startedAt)} - {run.model}
                  {run.fallback ? ' (fallback)' : ''} - {run.credits} credits -{' '}
                  {run.endedAt ? (run.stopReason ?? run.outcome ?? 'ended') : 'running'}
                  {run.reason ? `: ${run.reason}` : ''}
                  {run.prUrl ? ` - ${run.prUrl}` : ''}
                </Typography>
                {run.sessionId && (
                  <Button size="sm" variant="plain" onClick={() => onOpenSession(run.sessionId!)}>
                    Open session
                  </Button>
                )}
              </Stack>
            ))}

            <Typography level="title-sm">Events</Typography>
            {events.length === 0 && <Typography level="body-xs">None.</Typography>}
            {events.map(event => (
              <Typography key={event.id} level="body-xs">
                {when(event.createdAt)} - {event.kind}: {event.reason}
                {event.resolution
                  ? ` (${event.resolution.outcome}${event.resolution.note ? `: ${event.resolution.note}` : ''})`
                  : ''}
              </Typography>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void save()} data-testid="local-loops-ticket-save-btn">
            Save
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Close
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
