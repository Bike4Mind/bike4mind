import React, { useMemo, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import type { AuditEntry } from '@bike4mind/common';
import { useUserActivity } from '@client/app/hooks/data/adminUserActivity';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import { EmptyState, ErrorState, RelativeTime, SectionCard, useUndoToast } from '../../../shared';
import { useAdminUserUpdate, type AdminUserUpdate } from '../actions/useAdminUserUpdate';
import type { AdminUserProfile } from '../userProfileModel';
import { auditUndo, describeAuditEntry, fieldLabel, formatAuditValue, type AuditUndo } from './auditSentence';
import { TimelineList, TimelineSkeleton, type TimelineItem } from './TimelineList';

// The sentence already carries the before/after for these, so the change list would repeat it.
const SELF_DESCRIBING_FIELDS: ReadonlySet<string> = new Set([
  'currentCredits',
  'isBanned',
  'isModerated',
  'emailVerified',
]);

const ChangeList: React.FC<{ entry: AuditEntry }> = ({ entry }) => {
  const changes = (entry.changes ?? []).filter(change => !SELF_DESCRIBING_FIELDS.has(change.field));
  if (changes.length === 0) return null;
  return (
    <Box
      component="ul"
      sx={{ m: 0, mt: 0.5, pl: 2, fontSize: 12, color: 'admin.inkMuted' }}
      data-testid="user-admin-log-changes"
    >
      {changes.map(change => (
        <li key={change.field}>
          {fieldLabel(change.field)}: {formatAuditValue(change.before)} {'\u2192'} {formatAuditValue(change.after)}
        </li>
      ))}
    </Box>
  );
};

/** Admin-made changes to this account, newest first. A plain field change that still stands can be undone. */
export const AdminLogTab: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const activity = useUserActivity(user.id, { direction: 'target', includeSecurity: false });
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const entries = useMemo(
    () => activity.data?.pages.flatMap(page => page.entries).filter(entry => entry.source === 'admin') ?? [],
    [activity.data]
  );

  const undo = async (entry: AuditEntry, { patch, redo }: AuditUndo) => {
    setUndoingId(entry.id);
    try {
      // auditUndo only emits isBanned / isModerated / tags (plus statusChangeReason), all fields of the update body.
      await update(patch as AdminUserUpdate);
    } catch {
      return; // useAdminUserUpdate already reported the failure.
    } finally {
      setUndoingId(null);
    }
    showUndo({ message: `Undone: ${describeAuditEntry(entry)}`, onUndo: () => update(redo as AdminUserUpdate) });
  };

  const items = entries.map((entry, index): TimelineItem => {
    const reversal = auditUndo(entry, entries.slice(0, index), user);
    return {
      id: entry.id,
      tile: { text: 'AD', tone: 'neutral' },
      summary: describeAuditEntry(entry),
      onOpen: () => setSelected(entry),
      meta: entry.reason ? `Reason: ${entry.reason}` : undefined,
      extra: <ChangeList entry={entry} />,
      aside: (
        <Stack alignItems="flex-end" gap={0.5}>
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="user-admin-log-actor">
            {entry.actor.name} {'\u00b7'} <RelativeTime at={entry.occurredAt} />
          </Typography>
          {reversal && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              loading={undoingId === entry.id}
              disabled={undoingId !== null && undoingId !== entry.id}
              onClick={() => void undo(entry, reversal)}
              data-testid="user-admin-log-undo-btn"
            >
              Undo
            </Button>
          )}
        </Stack>
      ),
    };
  });

  const body = () => {
    if (activity.isLoading) return <TimelineSkeleton />;
    if (activity.isError) {
      return <ErrorState message="The admin log could not be loaded." onRetry={() => void activity.refetch()} />;
    }
    // Filtering happens after paging, so an empty page proves nothing while older pages remain.
    if (items.length === 0) {
      return (
        <EmptyState
          title="No admin changes yet"
          description={
            activity.hasNextPage
              ? 'No admin changes in the latest activity. Load more to check older entries.'
              : 'Changes admins make to this account appear here.'
          }
          action={null}
        />
      );
    }
    return <TimelineList items={items} rowTestId="user-admin-log-row" data-testid="user-profile-admin-log-list" />;
  };

  return (
    <>
      <SectionCard title="Admin actions on this account" body="custom" data-testid="user-profile-admin-log">
        {body()}
        {activity.hasNextPage && (
          <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'admin.border' }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
              data-testid="user-profile-admin-log-more-btn"
            >
              Load more
            </Button>
          </Box>
        )}
      </SectionCard>
      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </>
  );
};
