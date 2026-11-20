import { useState } from 'react';
import { IconButton, Input, Stack } from '@mui/joy';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';
import { useRateLoopTicket, type ILoopTicket } from '@client/app/hooks/data/loops';

const NOTE_MAX = 500;

/**
 * The owner's thumbs up or down on a closed ticket, with an optional note saved on Enter or blur. Clicking the active
 * thumb clears the rating. The loop's only quality signal (the Stats panel counts them).
 */
export default function LoopTicketRating({ loopId, ticket }: { loopId: string; ticket: ILoopTicket }) {
  const rate = useRateLoopTicket();
  const value = ticket.ownerRating?.value;
  const saved = ticket.ownerRating?.note ?? '';
  const [note, setNote] = useState(saved);
  // A refetch with another saved note (another tab, a cleared rating) replaces the draft.
  const [lastSaved, setLastSaved] = useState(saved);
  if (saved !== lastSaved) {
    setLastSaved(saved);
    setNote(saved);
  }

  const save = (next: 'up' | 'down' | null) =>
    rate.mutate({ loopId, ticketId: ticket.id, value: next, ...(next && note.trim() && { note: note.trim() }) });
  const saveNote = () => {
    if (value && note.trim() !== saved) save(value);
  };

  return (
    <Stack direction="row" gap={0.5} alignItems="center" onClick={event => event.stopPropagation()}>
      <IconButton
        size="sm"
        variant="plain"
        color={value === 'up' ? 'success' : 'neutral'}
        aria-label={value === 'up' ? 'Clear rating' : 'Rate up'}
        aria-pressed={value === 'up'}
        disabled={rate.isPending}
        onClick={() => save(value === 'up' ? null : 'up')}
        data-testid="loop-ticket-rating-up-btn"
      >
        {value === 'up' ? <ThumbUpIcon /> : <ThumbUpOutlinedIcon />}
      </IconButton>
      <IconButton
        size="sm"
        variant="plain"
        color={value === 'down' ? 'danger' : 'neutral'}
        aria-label={value === 'down' ? 'Clear rating' : 'Rate down'}
        aria-pressed={value === 'down'}
        disabled={rate.isPending}
        onClick={() => save(value === 'down' ? null : 'down')}
        data-testid="loop-ticket-rating-down-btn"
      >
        {value === 'down' ? <ThumbDownIcon /> : <ThumbDownOutlinedIcon />}
      </IconButton>
      {value && (
        <Input
          size="sm"
          placeholder="Note (optional)"
          value={note}
          onChange={event => setNote(event.target.value.slice(0, NOTE_MAX))}
          onBlur={saveNote}
          onKeyDown={event => {
            if (event.key === 'Enter') saveNote();
          }}
          sx={{ flex: 1, minWidth: 0 }}
          slotProps={{ input: { 'aria-label': 'Rating note', 'data-testid': 'loop-ticket-rating-note-input' } }}
        />
      )}
    </Stack>
  );
}
