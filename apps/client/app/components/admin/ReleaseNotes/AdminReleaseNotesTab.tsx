import React, { useState } from 'react';
import { Alert, Box, Button, ButtonGroup, Card, Chip, Divider, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';
import ReleaseNoteEditDialog from './ReleaseNoteEditDialog';
import ReleaseNotesConfigEditor from './ReleaseNotesConfigEditor';
import {
  type AdminReleaseNote,
  type ReleaseNoteAction,
  type ReleaseNoteState,
  useReleaseNotes,
  useReleaseNoteStatus,
} from './useReleaseNotes';

const FILTERS: { value: ReleaseNoteState; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'published', label: 'Published' },
  { value: 'hidden', label: 'Hidden' },
];

const MS_PER_HOUR = 60 * 60 * 1000;

// `now` comes from the list fetch time so render stays pure.
const StateChip: React.FC<{ note: AdminReleaseNote; now: number }> = ({ note, now }) => {
  if (note.state === 'published') return <Chip color="success">Published</Chip>;
  if (note.state === 'hidden') return <Chip color="neutral">Hidden</Chip>;
  const hours = Math.max(0, Math.ceil((new Date(note.publishAt).getTime() - now) / MS_PER_HOUR));
  return <Chip color="warning">Goes live in {hours}h</Chip>;
};

const ReleaseNoteCard: React.FC<{
  note: AdminReleaseNote;
  onAction: (note: AdminReleaseNote, action: ReleaseNoteAction) => void;
  onEdit: (note: AdminReleaseNote) => void;
  busy: boolean;
  now: number;
}> = ({ note, onAction, onEdit, busy, now }) => {
  const empty = note.items.length === 0;
  return (
    <Card variant="outlined" data-testid="release-notes-card">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <StateChip note={note} now={now} />
        <Typography level="body-sm">{note.releaseTag}</Typography>
        <Typography level="body-xs">publishes {new Date(note.publishAt).toLocaleString()}</Typography>
        {note.editedAt && <Typography level="body-xs">edited</Typography>}
        {note.deniedTerm && (
          <Chip color="danger" variant="soft" data-testid="release-notes-denied-chip">
            Withheld from the feed: mentions &quot;{note.deniedTerm}&quot;
          </Chip>
        )}
      </Stack>
      <Typography level="title-md">{note.headline || '(no headline)'}</Typography>
      {note.summary && <Typography level="body-sm">{note.summary}</Typography>}
      {empty ? (
        <Typography level="body-sm" color="warning">
          No customer-facing items. Add items before this note can go live.
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, pl: 3 }}>
          {note.items.map((item, index) => (
            <li key={index}>
              <Typography level="body-sm">
                [{item.category}] {item.text}
              </Typography>
            </li>
          ))}
        </Box>
      )}
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Button size="sm" variant="outlined" onClick={() => onEdit(note)} data-testid="release-notes-edit-btn">
          Edit
        </Button>
        {note.state === 'hidden' ? (
          <Button
            size="sm"
            disabled={busy || empty}
            onClick={() => onAction(note, 'unhide')}
            data-testid="release-notes-unhide-btn"
          >
            Unhide
          </Button>
        ) : (
          <Button
            size="sm"
            color="danger"
            variant="soft"
            disabled={busy}
            onClick={() => onAction(note, 'hide')}
            data-testid="release-notes-hide-btn"
          >
            Hide
          </Button>
        )}
        {note.state === 'scheduled' && (
          <Button
            size="sm"
            color="success"
            disabled={busy || empty}
            onClick={() => onAction(note, 'publishNow')}
            data-testid="release-notes-publish-now-btn"
          >
            Publish now
          </Button>
        )}
      </Stack>
    </Card>
  );
};

const AdminReleaseNotesTab: React.FC = () => {
  const [status, setStatus] = useState<ReleaseNoteState>('scheduled');
  const [editing, setEditing] = useState<AdminReleaseNote | null>(null);
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage, dataUpdatedAt } =
    useReleaseNotes(status);
  const statusMutation = useReleaseNoteStatus();
  const notes = data?.pages.flatMap(page => page.data) ?? [];

  const onAction = (note: AdminReleaseNote, action: ReleaseNoteAction) =>
    statusMutation.mutate(
      { id: note.id, action },
      {
        onSuccess: () => toast.success(action === 'hide' ? 'Release note hidden' : 'Release note updated'),
        onError: err => toast.error(getErrorMessage(err)),
      }
    );

  return (
    <Stack spacing={3} sx={{ p: { xs: 1, sm: 2 } }}>
      <Typography level="h3">Release notes</Typography>
      <Alert color="neutral" variant="soft" data-testid="release-notes-cache-note">
        Customer-facing release notes generated from each production release and served by GET /api/v1/whats-new. This
        is separate from the What&apos;s New Modals tab. Hiding a published note can take up to ~15 minutes to clear CDN
        and downstream caches.
      </Alert>
      <ReleaseNotesConfigEditor />
      <Divider />
      <ButtonGroup aria-label="Filter release notes by status">
        {FILTERS.map(filter => (
          <Button
            key={filter.value}
            variant={status === filter.value ? 'solid' : 'outlined'}
            onClick={() => setStatus(filter.value)}
            data-testid={`release-notes-filter-${filter.value}-btn`}
          >
            {filter.label}
          </Button>
        ))}
      </ButtonGroup>
      {isLoading && <Typography level="body-sm">Loading release notes...</Typography>}
      {error && <Alert color="danger">Could not load release notes: {getErrorMessage(error)}</Alert>}
      {!isLoading && !error && notes.length === 0 && (
        <Typography level="body-sm" data-testid="release-notes-empty">
          No {status} release notes.
        </Typography>
      )}
      <Stack spacing={2}>
        {notes.map(note => (
          <ReleaseNoteCard
            key={note.id}
            note={note}
            onAction={onAction}
            onEdit={setEditing}
            busy={statusMutation.isPending}
            now={dataUpdatedAt}
          />
        ))}
      </Stack>
      {hasNextPage && (
        <Box>
          <Button variant="outlined" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
            Load more
          </Button>
        </Box>
      )}
      {editing && <ReleaseNoteEditDialog note={editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
};

export default AdminReleaseNotesTab;
