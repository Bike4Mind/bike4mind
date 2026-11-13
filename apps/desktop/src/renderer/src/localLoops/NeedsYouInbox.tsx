import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AnswerLocalEventRequest, LocalLoopDetail } from '@shared/localLoops';
import { loopNeedsYouItems, type LoopNeedsYouItem } from '@shared/needsYou';

function Item({
  item,
  onAnswer,
  onReopen,
}: {
  item: LoopNeedsYouItem;
  onAnswer: (request: AnswerLocalEventRequest) => void;
  onReopen: (ticketId: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Stack
      spacing={1}
      data-testid={`local-loops-needs-you-${item.ticketId}`}
      sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 'sm' }}
    >
      <Typography level="title-sm">{item.title}</Typography>
      <Typography level="body-sm">{item.reason}</Typography>
      {item.eventId ? (
        <Stack direction="row" spacing={1}>
          <Input
            size="sm"
            placeholder="Your answer"
            value={note}
            onChange={event => setNote(event.target.value)}
            sx={{ flex: 1 }}
            slotProps={{ input: { 'data-testid': `local-loops-answer-input-${item.ticketId}` } }}
          />
          <Button
            size="sm"
            disabled={!note.trim()}
            onClick={() => onAnswer({ id: item.eventId!, outcome: 'answered', note: note.trim() })}
            data-testid={`local-loops-answer-btn-${item.ticketId}`}
          >
            Answer
          </Button>
          <Button
            size="sm"
            variant="soft"
            color="danger"
            onClick={() =>
              onAnswer({ id: item.eventId!, outcome: 'rejected', ...(note.trim() && { note: note.trim() }) })
            }
            data-testid={`local-loops-reject-btn-${item.ticketId}`}
          >
            Reject
          </Button>
        </Stack>
      ) : (
        <Button size="sm" variant="soft" sx={{ alignSelf: 'flex-start' }} onClick={() => onReopen(item.ticketId)}>
          Reopen
        </Button>
      )}
    </Stack>
  );
}

/** What the loop waits on the owner for: its questions (answer or reject), blocked tickets (reopen), and a cap or error. */
export function NeedsYouInbox({
  detail,
  onAnswer,
  onReopen,
}: {
  detail: LocalLoopDetail;
  onAnswer: (request: AnswerLocalEventRequest) => void;
  onReopen: (ticketId: string) => void;
}) {
  const items = loopNeedsYouItems(detail);
  const banner = detail.loop.cappedUntil || detail.loop.status === 'error' ? detail.idleReason : undefined;
  return (
    <Stack spacing={1.5} sx={{ p: 1.5, overflowY: 'auto' }} data-testid="local-loops-needs-you">
      {banner && (
        <Alert color={detail.loop.status === 'error' ? 'danger' : 'warning'} data-testid="local-loops-idle-banner">
          {banner.charAt(0).toUpperCase() + banner.slice(1)}
        </Alert>
      )}
      {items.length === 0 && !banner && <Typography level="body-sm">Nothing is waiting on you.</Typography>}
      {items.map(item => (
        <Item key={item.ticketId} item={item} onAnswer={onAnswer} onReopen={onReopen} />
      ))}
    </Stack>
  );
}
