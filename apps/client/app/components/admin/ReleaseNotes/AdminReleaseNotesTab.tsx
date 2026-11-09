import React, { useState } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';
import { SettingsDraftProvider } from '../SettingsDraftProvider';
import {
  AdminPageHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionCard,
  StatusChip,
  UpdatingBar,
  ViewTabs,
} from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import ReleaseNoteEditDialog from './ReleaseNoteEditDialog';
import ReleaseNotesConfigEditor from './ReleaseNotesConfigEditor';
import {
  type AdminReleaseNote,
  type ReleaseNoteAction,
  type ReleaseNoteState,
  useReleaseNotes,
  useReleaseNoteStatus,
} from './useReleaseNotes';

const FILTERS: { value: ReleaseNoteState; label: string; empty: string }[] = [
  { value: 'scheduled', label: 'Scheduled', empty: 'A new note waits here from its release until it goes live.' },
  { value: 'published', label: 'Published', empty: 'Notes show here once they go live.' },
  { value: 'hidden', label: 'Hidden', empty: 'Notes you hide show here.' },
];

const MS_PER_HOUR = 60 * 60 * 1000;

// `now` comes from the list fetch time so render stays pure.
const StateChip: React.FC<{ note: AdminReleaseNote; now: number }> = ({ note, now }) => {
  if (note.state === 'published') return <StatusChip tone="good" label="Published" />;
  if (note.state === 'hidden') return <StatusChip tone="neutral" label="Hidden" />;
  const hours = Math.max(0, Math.ceil((new Date(note.publishAt).getTime() - now) / MS_PER_HOUR));
  return <StatusChip tone="warn" label={`Goes live in ${hours}h`} />;
};

/** One note as a row of the list card; rows are divided by hairlines, never cards of their own. */
const ReleaseNoteRow: React.FC<{
  note: AdminReleaseNote;
  onAction: (note: AdminReleaseNote, action: ReleaseNoteAction) => void;
  onEdit: (note: AdminReleaseNote) => void;
  busy: boolean;
  now: number;
}> = ({ note, onAction, onEdit, busy, now }) => {
  const empty = note.items.length === 0;
  return (
    <Stack
      component="article"
      sx={{ gap: 1, p: 2, minWidth: 0, '& + &': { borderTop: '1px solid', borderColor: 'admin.border' } }}
      data-testid="release-notes-row"
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <StateChip note={note} now={now} />
        <Typography
          level="body-xs"
          sx={{ fontFamily: 'code', color: 'admin.inkMuted' }}
          data-testid="release-notes-row-tag"
        >
          {note.releaseTag}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          publishes {new Date(note.publishAt).toLocaleString()}
        </Typography>
        {note.editedAt && (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            edited
          </Typography>
        )}
        {note.deniedTerm && (
          // A Joy Chip is max-content wide, so a long term would run past a narrow row; capped, it truncates.
          <Box sx={{ minWidth: 0, maxWidth: '100%', '& > .MuiChip-root': { maxWidth: '100%' } }}>
            <StatusChip
              tone="bad"
              label={`Withheld from the feed: mentions "${note.deniedTerm}"`}
              data-testid="release-notes-denied-chip"
            />
          </Box>
        )}
      </Stack>
      <Typography level="title-md" sx={{ color: 'admin.ink', overflowWrap: 'anywhere' }}>
        {note.headline || '(no headline)'}
      </Typography>
      {note.summary && (
        <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
          {note.summary}
        </Typography>
      )}
      {empty ? (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="release-notes-no-items">
          No customer-facing items. Add items before this note can go live.
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, pl: 3 }}>
          {note.items.map((item, index) => (
            <li key={index}>
              <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                [{item.category}] {item.text}
              </Typography>
            </li>
          ))}
        </Box>
      )}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={() => onEdit(note)}
          data-testid="release-notes-edit-btn"
        >
          Edit
        </Button>
        {note.state === 'hidden' ? (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            disabled={busy || empty}
            onClick={() => onAction(note, 'unhide')}
            data-testid="release-notes-unhide-btn"
          >
            Unhide
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
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
            variant="outlined"
            color="neutral"
            disabled={busy || empty}
            onClick={() => onAction(note, 'publishNow')}
            data-testid="release-notes-publish-now-btn"
          >
            Publish now
          </Button>
        )}
      </Stack>
    </Stack>
  );
};

const AdminReleaseNotesTab: React.FC = () => {
  const [status, setStatus] = useState<ReleaseNoteState>('scheduled');
  const [editing, setEditing] = useState<AdminReleaseNote | null>(null);
  const { data, isLoading, error, refetch, isFetching, isRefetching, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useReleaseNotes(status);
  const statusMutation = useReleaseNoteStatus();
  const notes = data?.pages.flatMap(page => page.data) ?? [];
  const fetchedAt = data?.pages.reduce((latest, page) => Math.max(latest, page.fetchedAt), 0) ?? 0;
  const filter = FILTERS.find(entry => entry.value === status) ?? FILTERS[0];
  // The empty state's next step: look at the list a note would have moved to.
  const fallback = FILTERS.find(entry => entry.value === (status === 'published' ? 'scheduled' : 'published'));

  const onAction = (note: AdminReleaseNote, action: ReleaseNoteAction) =>
    statusMutation.mutate(
      { id: note.id, action },
      {
        onSuccess: () => toast.success(action === 'hide' ? 'Release note hidden' : 'Release note updated'),
        onError: err => toast.error(getErrorMessage(err)),
      }
    );

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP }} data-testid="admin-release-notes-tab">
      {/* Wraps the whole page so the settings' one SaveBar sits at its foot, below the list. */}
      <SettingsDraftProvider>
        <AdminPageHeader
          title="Release notes"
          description="Customer-facing notes generated from each production release and served by GET /api/v1/whats-new, separate from What's new modals."
        />
        <ReleaseNotesConfigEditor />
        <Stack sx={{ gap: 2 }}>
          <ViewTabs
            views={FILTERS.map(entry => ({ id: entry.value, label: entry.label }))}
            activeId={status}
            onSelect={id => {
              const next = FILTERS.find(entry => entry.value === id);
              if (next) setStatus(next.value);
            }}
            aria-label="Filter release notes by status"
            data-testid="release-notes-filter"
          />
          {/* Not on the first load (the card shows LoadingState) or a Load more (its button spins). */}
          <UpdatingBar active={Boolean(data) && isFetching && !isFetchingNextPage} testId="release-notes-updating" />
          <SectionCard
            title={`${filter.label} notes`}
            body="custom"
            action={
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="release-notes-cache-note">
                Hiding a published note can take up to 15 minutes to clear CDN and downstream caches.
              </Typography>
            }
            data-testid="release-notes-list"
          >
            {isLoading ? (
              <LoadingState label="Loading release notes" testId="release-notes-loading" />
            ) : error && notes.length === 0 ? (
              <ErrorState
                message={`Could not load release notes: ${getErrorMessage(error)}`}
                onRetry={() => void refetch()}
                retrying={isRefetching}
              />
            ) : notes.length === 0 ? (
              <EmptyState
                title={`No ${status} release notes`}
                description={filter.empty}
                action={
                  fallback && (
                    <Button
                      size="sm"
                      variant="outlined"
                      onClick={() => setStatus(fallback.value)}
                      data-testid="release-notes-empty-show-btn"
                    >
                      Show {fallback.value} notes
                    </Button>
                  )
                }
              />
            ) : (
              <>
                {/* A failed refetch or Load more keeps the rows it already has. */}
                {error && (
                  <Box sx={{ px: 2, pt: 2 }}>
                    <Alert
                      color="danger"
                      variant="soft"
                      data-testid="release-notes-list-error"
                      endDecorator={
                        <Button
                          size="sm"
                          variant="outlined"
                          color="neutral"
                          loading={isRefetching}
                          onClick={() => void refetch()}
                          data-testid="release-notes-list-retry-btn"
                        >
                          Try again
                        </Button>
                      }
                    >
                      Could not load release notes: {getErrorMessage(error)}
                    </Alert>
                  </Box>
                )}
                {notes.map(note => (
                  <ReleaseNoteRow
                    key={note.id}
                    note={note}
                    onAction={onAction}
                    onEdit={setEditing}
                    busy={statusMutation.isPending}
                    now={fetchedAt}
                  />
                ))}
              </>
            )}
          </SectionCard>
          {hasNextPage && (
            <Box>
              <Button
                variant="outlined"
                loading={isFetchingNextPage}
                onClick={() => fetchNextPage()}
                data-testid="release-notes-load-more-btn"
              >
                Load more
              </Button>
            </Box>
          )}
        </Stack>
        {editing && <ReleaseNoteEditDialog note={editing} onClose={() => setEditing(null)} />}
      </SettingsDraftProvider>
    </Stack>
  );
};

export default AdminReleaseNotesTab;
