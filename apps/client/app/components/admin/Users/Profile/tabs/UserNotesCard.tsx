import React, { useState } from 'react';
import { isAxiosError } from 'axios';
import { Button, Stack, Textarea, Typography } from '@mui/joy';
import { ADMIN_NOTE_MAX_LENGTH, hasAdminPermission, type AdminUserNote } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useAdminUserNoteHistory,
  useAdminUserNotes,
  useWriteAdminUserNote,
} from '@client/app/hooks/data/adminUserNotes';
import { RelativeTime, SectionCard, useUndoToast } from '../../../shared';
import type { AdminUserProfile } from '../userProfileModel';

const NoteHistory: React.FC<{ userId: string; noteId: string }> = ({ userId, noteId }) => {
  const history = useAdminUserNoteHistory(userId, noteId);
  return (
    <Stack gap={1} data-testid="user-note-history">
      {history.isLoading && <Typography level="body-sm">Loading history...</Typography>}
      {history.isError && (
        <Button variant="outlined" onClick={() => void history.refetch()} data-testid="user-note-history-retry-btn">
          Reload history
        </Button>
      )}
      {history.data?.pages
        .flatMap(page => page.entries)
        .map(revision => (
          <Stack key={revision.version} gap={0.5}>
            <Typography level="body-xs">
              Version {revision.version} by {revision.editor.name} {'\u00b7'} <RelativeTime at={revision.updatedAt} />
              {revision.deleted && ' (deleted)'}
            </Typography>
            <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {revision.body}
            </Typography>
          </Stack>
        ))}
      {history.hasNextPage && (
        <Button
          variant="plain"
          loading={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
          data-testid="user-note-history-more-btn"
        >
          Load older versions
        </Button>
      )}
    </Stack>
  );
};

export const UserNotesCard: React.FC<{ user: AdminUserProfile }> = ({ user }) => (
  <UserNotesContent key={user.id} user={user} />
);

const UserNotesContent: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const { currentUser } = useUser();
  const canRead = hasAdminPermission(currentUser, 'support:read');
  const canWrite = hasAdminPermission(currentUser, 'users:moderate');
  const notes = useAdminUserNotes(user.id, canRead);
  const write = useWriteAdminUserNote(user.id);
  const showUndo = useUndoToast();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<AdminUserNote | null>(null);
  const [editBody, setEditBody] = useState('');
  const [editConflict, setEditConflict] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  if (!canRead) return null;

  const currentNotes = notes.data?.pages.flatMap(page => page.entries) ?? [];
  const missingEditedNote = editing !== null && !currentNotes.some(note => note.id === editing.id);
  const displayedNotes = missingEditedNote && editing ? [...currentNotes, editing] : currentNotes;

  const change = async (note: AdminUserNote, input: { body: string } | { deleted: boolean }) => {
    try {
      const saved = await write.mutateAsync({ noteId: note.id, version: note.version, ...input });
      if (editing?.id === note.id) {
        setEditing(null);
        setEditConflict(false);
      }
      showUndo({
        message: 'Note updated',
        onUndo: async () => {
          await write.mutateAsync({
            noteId: saved.id,
            version: saved.version,
            ...('body' in input ? { body: note.body } : { deleted: note.deleted }),
          });
        },
      });
    } catch (error: unknown) {
      if ('body' in input && isAxiosError(error) && error.response?.status === 409) setEditConflict(true);
      throw error;
    }
  };
  const add = async () => {
    const saved = await write.mutateAsync({ body: draft.trim() });
    setDraft('');
    showUndo({
      message: 'Note added',
      onUndo: async () => {
        await write.mutateAsync({ noteId: saved.id, version: saved.version, deleted: true });
      },
    });
  };
  const safely = (operation: Promise<unknown>) => {
    void operation.catch(() => {});
  };

  return (
    <SectionCard title="Internal notes" body="custom" data-testid="user-profile-notes-card">
      <Stack gap={1.5} sx={{ p: 2 }} data-testid="user-notes-list">
        <Typography level="body-xs">
          Visible to administrators only. Edits and deletions retain attributed history.
        </Typography>
        {notes.isLoading && <Typography level="body-sm">Loading notes...</Typography>}
        {notes.isError && (
          <Stack gap={1}>
            <Typography role="alert">Notes could not be loaded.</Typography>
            <Button variant="outlined" onClick={() => void notes.refetch()} data-testid="user-notes-retry-btn">
              Reload notes
            </Button>
          </Stack>
        )}
        {displayedNotes.map(note => (
          <Stack
            key={note.id}
            gap={0.75}
            sx={{ borderBottom: '1px solid', borderColor: 'admin.border', pb: 1.5 }}
            data-testid="user-note-row"
          >
            <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {note.body}
            </Typography>
            <Stack direction="row" gap={0.5} flexWrap="wrap">
              <Typography level="body-xs">{note.author.name}</Typography>
              <RelativeTime at={note.createdAt} />
              {note.version > 1 && <Typography level="body-xs">(edited, version {note.version})</Typography>}
            </Stack>
            <Button
              variant="plain"
              onClick={() => setHistoryId(historyId === note.id ? null : note.id)}
              data-testid={`user-note-history-${note.id}-btn`}
            >
              View history
            </Button>
            {historyId === note.id && <NoteHistory userId={user.id} noteId={note.id} />}
            {canWrite && !(missingEditedNote && note.id === editing?.id) && (
              <Stack direction="row" gap={1}>
                <Button
                  variant="plain"
                  disabled={write.isPending}
                  onClick={() => {
                    setEditing(note);
                    setEditBody(note.body);
                    setEditConflict(false);
                  }}
                  data-testid={`user-note-edit-${note.id}-btn`}
                >
                  Edit note
                </Button>
                <Button
                  variant="plain"
                  disabled={write.isPending}
                  onClick={() => safely(change(note, { deleted: true }))}
                  data-testid={`user-note-delete-${note.id}-btn`}
                >
                  Delete note
                </Button>
              </Stack>
            )}
            {editing?.id === note.id && (
              <Stack gap={1}>
                {(editConflict || missingEditedNote) && (
                  <Typography role="alert" level="body-sm">
                    {missingEditedNote
                      ? 'This note is no longer available. Your draft is kept here. Copy it before choosing Cancel.'
                      : 'This note changed. Your draft is kept here. Copy it before choosing Cancel, then Edit note to start from the latest version.'}
                  </Typography>
                )}
                <Textarea
                  disabled={write.isPending}
                  value={editBody}
                  onChange={event => setEditBody(event.target.value)}
                  slotProps={{
                    textarea: {
                      maxLength: ADMIN_NOTE_MAX_LENGTH,
                      'aria-label': 'Edit note',
                      'data-testid': 'user-note-edit-input',
                    },
                  }}
                />
                <Stack direction="row" gap={1}>
                  <Button variant="plain" onClick={() => setEditing(null)} data-testid="user-note-cancel-btn">
                    Cancel
                  </Button>
                  <Button
                    disabled={!editBody.trim() || write.isPending || editConflict || missingEditedNote}
                    onClick={() => safely(change(editing, { body: editBody.trim() }))}
                    data-testid="user-note-save-btn"
                  >
                    Save note
                  </Button>
                </Stack>
              </Stack>
            )}
          </Stack>
        ))}
        {notes.data && displayedNotes.length === 0 && <Typography level="body-sm">No internal notes yet.</Typography>}
        {notes.hasNextPage && (
          <Button
            variant="outlined"
            loading={notes.isFetchingNextPage}
            onClick={() => void notes.fetchNextPage()}
            data-testid="user-notes-load-more-btn"
          >
            Load older notes
          </Button>
        )}
        {(user.userNotes ?? []).map((note, index) => (
          <Stack key={index} gap={0.5} data-testid="user-note-legacy-row">
            <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {note.note}
            </Typography>
            <Typography level="body-xs">
              {note.userName} {'\u00b7'} {note.timestamp} (legacy, read-only)
            </Typography>
          </Stack>
        ))}
        {canWrite && (
          <Stack gap={1}>
            <Textarea
              disabled={write.isPending}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder="Add an internal note..."
              slotProps={{
                textarea: {
                  maxLength: ADMIN_NOTE_MAX_LENGTH,
                  'aria-label': 'Add a note',
                  'data-testid': 'user-profile-note-input',
                },
              }}
            />
            <Button
              disabled={!draft.trim() || write.isPending}
              onClick={() => safely(add())}
              data-testid="user-note-add-btn"
            >
              Add note
            </Button>
          </Stack>
        )}
      </Stack>
    </SectionCard>
  );
};
