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
  ticketId,
  onAnswer,
  onReopen,
}: {
  item: LoopNeedsYouItem;
  ticketId: string;
  onAnswer: (request: AnswerLocalEventRequest) => void;
  onReopen: (ticketId: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Stack
      spacing={1}
      data-testid={`local-loops-needs-you-${ticketId}`}
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
            slotProps={{ input: { 'data-testid': `local-loops-answer-input-${ticketId}` } }}
          />
          <Button
            size="sm"
            disabled={!note.trim()}
            onClick={() => onAnswer({ id: item.eventId!, outcome: 'answered', note: note.trim() })}
            data-testid={`local-loops-answer-btn-${ticketId}`}
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
            data-testid={`local-loops-reject-btn-${ticketId}`}
          >
            Reject
          </Button>
        </Stack>
      ) : (
        <Button size="sm" variant="soft" sx={{ alignSelf: 'flex-start' }} onClick={() => onReopen(ticketId)}>
          Reopen
        </Button>
      )}
    </Stack>
  );
}

/**
 * What the loop waits on the owner for: the loop itself when capped, in error (resume) or stalled, then its
 * questions (answer or reject) and blocked tickets (reopen).
 */
export function NeedsYouInbox({
  detail,
  onAnswer,
  onReopen,
  onResume,
}: {
  detail: LocalLoopDetail;
  onAnswer: (request: AnswerLocalEventRequest) => void;
  onReopen: (ticketId: string) => void;
  onResume: () => void;
}) {
  const items = loopNeedsYouItems(detail);
  const [loopItem] = items.filter(item => !item.ticketId);
  const error = detail.loop.status === 'error';
  return (
    <Stack spacing={1.5} sx={{ p: 1.5, overflowY: 'auto' }} data-testid="local-loops-needs-you">
      {loopItem && (
        <Alert
          color={error ? 'danger' : 'warning'}
          data-testid="local-loops-idle-banner"
          endDecorator={
            error && (
              <Button size="sm" color="danger" onClick={onResume} data-testid="local-loops-banner-resume-btn">
                Resume
              </Button>
            )
          }
        >
          {loopItem.reason.charAt(0).toUpperCase() + loopItem.reason.slice(1)}
        </Alert>
      )}
      {items.length === 0 && <Typography level="body-sm">Nothing is waiting on you.</Typography>}
      {items.map(
        item =>
          item.ticketId && (
            <Item key={item.ticketId} item={item} ticketId={item.ticketId} onAnswer={onAnswer} onReopen={onReopen} />
          )
      )}
    </Stack>
  );
}
