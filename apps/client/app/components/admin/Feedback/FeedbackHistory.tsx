import { useState } from 'react';
import { Alert, Button, Stack, Textarea, Typography } from '@mui/joy';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { addFeedbackNoteOnServer, getFeedbackHistoryFromServer } from '@client/app/utils/feedbackAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { ADMIN_NOTE_MAX_LENGTH, FEEDBACK_RESOLUTION_LABELS, type FeedbackResolution } from '@bike4mind/common';
import { SectionCard, LoadingState, ErrorState } from '../shared';

const FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  resolution: 'Resolution',
  resolutionDuplicateId: 'Duplicate of',
};

const changeValue = (field: string, value: unknown) =>
  field === 'resolution' && typeof value === 'string'
    ? (FEEDBACK_RESOLUTION_LABELS[value as FeedbackResolution] ?? value)
    : String(value ?? 'None');

export default function FeedbackHistory({ id }: { id: string }) {
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const history = useInfiniteQuery({
    queryKey: ['feedback-history', id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getFeedbackHistoryFromServer(id, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const addNote = useMutation({
    mutationFn: (body: string) => addFeedbackNoteOnServer(id, body),
    onSuccess: async () => {
      setNote('');
      await client.invalidateQueries({ queryKey: ['feedback-history', id] });
    },
  });
  return (
    <SectionCard title="Internal history" body="custom" data-testid="feedback-history">
      <Stack gap={2} sx={{ p: 2 }}>
        <Typography level="body-sm">
          Notes are private to moderators and expire with the report text. Audit metadata remains in history.
        </Typography>
        {history.isPending ? (
          <LoadingState label="Loading history" />
        ) : history.isError ? (
          <ErrorState message="Could not load history." onRetry={() => void history.refetch()} />
        ) : (
          <>
            {history.data.pages
              .flatMap(page => page.items)
              .map(item => (
                <Stack key={item.id} gap={0.5} data-testid={`feedback-history-entry-${item.id}`}>
                  <Typography level="body-xs">
                    {item.author} - {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {item.note ?? item.summary}
                  </Typography>
                  {item.reason && <Typography level="body-xs">Reason: {item.reason}</Typography>}
                  {item.changes?.map(change => (
                    <Typography key={change.field} level="body-xs">
                      {FIELD_LABELS[change.field] ?? change.field}: {changeValue(change.field, change.before)} to{' '}
                      {changeValue(change.field, change.after)}
                    </Typography>
                  ))}
                </Stack>
              ))}
            {history.data.pages[0].items.length === 0 && (
              <Typography level="body-sm">No changes or notes yet.</Typography>
            )}
            {history.hasNextPage && (
              <Button
                variant="plain"
                loading={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
                data-testid="feedback-history-more-btn"
              >
                Load older entries
              </Button>
            )}
          </>
        )}
        <Textarea
          disabled={addNote.isPending}
          value={note}
          onChange={event => setNote(event.target.value)}
          minRows={3}
          slotProps={{
            textarea: {
              maxLength: ADMIN_NOTE_MAX_LENGTH,
              'aria-label': 'Internal note',
              'data-testid': 'feedback-note-input',
            },
          }}
        />
        {addNote.isError && (
          <Alert color="danger" data-testid="feedback-note-error">
            {getErrorMessage(addNote.error)}
          </Alert>
        )}
        <Button
          variant="outlined"
          loading={addNote.isPending}
          disabled={addNote.isPending || !note.trim() || note.trim().length > ADMIN_NOTE_MAX_LENGTH}
          onClick={() => addNote.mutate(note.trim())}
          data-testid="feedback-note-add-btn"
        >
          Add internal note
        </Button>
      </Stack>
    </SectionCard>
  );
}
