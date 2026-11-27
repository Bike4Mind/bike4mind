import React, { useMemo, useState } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import type { AuditEntry } from '@bike4mind/common';
import { useAdminSubscriptionAdminLog } from '@client/app/hooks/data/adminSubscriptionDetail';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import { EmptyState, ErrorState, RelativeTime, SectionCard } from '../../../shared';
import { describeAuditEntry, fieldLabel, formatAuditValue } from '../../../Users/Profile/tabs/auditSentence';
import { TimelineList, TimelineSkeleton, type TimelineItem } from '../../../Users/Profile/tabs/TimelineList';

const ChangeList: React.FC<{ entry: AuditEntry }> = ({ entry }) => {
  const changes = entry.changes ?? [];
  if (changes.length === 0) return null;
  return (
    <Box
      component="ul"
      sx={{ m: 0, mt: 0.5, pl: 2, fontSize: 12, color: 'admin.inkMuted' }}
      data-testid="subscription-admin-log-changes"
    >
      {changes.map(change => (
        <li key={change.field}>
          {fieldLabel(change.field)}: {formatAuditValue(change.before)} {'\u2192'} {formatAuditValue(change.after)}
        </li>
      ))}
    </Box>
  );
};

/**
 * Every admin change to this subscription, newest first. Undo lives on the toast right after a change;
 * the log itself is read-only.
 */
export const SubscriptionAdminLogTab: React.FC<{ subscriptionId: string }> = ({ subscriptionId }) => {
  const log = useAdminSubscriptionAdminLog(subscriptionId);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const entries = useMemo(() => log.data?.pages.flatMap(page => page.entries) ?? [], [log.data]);

  const items = entries.map((entry): TimelineItem => ({
    id: entry.id,
    tile: { text: 'AD', tone: 'neutral' },
    summary: describeAuditEntry(entry),
    onOpen: () => setSelected(entry),
    meta: entry.reason ? `Reason: ${entry.reason}` : undefined,
    extra: <ChangeList entry={entry} />,
    aside: (
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="subscription-admin-log-actor">
        {entry.actor.name} {'\u00b7'} <RelativeTime at={entry.occurredAt} />
      </Typography>
    ),
  }));

  const body = () => {
    if (log.isLoading) return <TimelineSkeleton />;
    if (log.isError) {
      return <ErrorState message="The admin log could not be loaded." onRetry={() => void log.refetch()} />;
    }
    if (items.length === 0) {
      return (
        <EmptyState
          title="No admin changes yet"
          description="Changes admins make to this subscription appear here."
          action={null}
        />
      );
    }
    return (
      <TimelineList items={items} rowTestId="subscription-admin-log-row" data-testid="subscription-admin-log-list" />
    );
  };

  return (
    <>
      <SectionCard title="Admin actions on this subscription" body="custom" data-testid="subscription-admin-log">
        {body()}
        {log.hasNextPage && (
          <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'admin.border' }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
              data-testid="subscription-admin-log-more-btn"
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
