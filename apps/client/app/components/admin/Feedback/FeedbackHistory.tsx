import { useState } from 'react';
import { Alert, Button, Stack, Textarea, Typography } from '@mui/joy';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { addFeedbackNoteOnServer, getFeedbackHistoryFromServer } from '@client/app/utils/feedbackAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { SectionCard, LoadingState, ErrorState } from '../shared';

export default function FeedbackHistory({ id }: { id: string }) {
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const history = useInfiniteQuery({
    queryKey: ['feedback-history', id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getFeedbackHistoryFromServer(id, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const addNote = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await addFeedbackNoteOnServer(id, note.trim());
      setNote('');
      await client.invalidateQueries({ queryKey: ['feedback-history', id] });
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SectionCard title="Internal history" body="custom" data-testid="feedback-history">
      <Stack gap={2} sx={{ p: 2 }}>
        <Typography level="body-sm">Notes are private to administrators and are never sent to the reporter.</Typography>
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
                  {item.changes?.map(change => (
                    <Typography key={change.field} level="body-xs">
                      {change.field}: {String(change.before ?? 'None')} to {String(change.after ?? 'None')}
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
          value={note}
          onChange={event => setNote(event.target.value)}
          minRows={3}
          slotProps={{
            textarea: { maxLength: 2000, 'aria-label': 'Internal note', 'data-testid': 'feedback-note-input' },
          }}
        />
        {error && (
          <Alert color="danger" data-testid="feedback-note-error">
            {error}
          </Alert>
        )}
        <Button
          variant="outlined"
          loading={saving}
          disabled={!note.trim() || note.trim().length > 2000}
          onClick={() => void addNote()}
          data-testid="feedback-note-add-btn"
        >
          Add internal note
        </Button>
      </Stack>
    </SectionCard>
  );
}
