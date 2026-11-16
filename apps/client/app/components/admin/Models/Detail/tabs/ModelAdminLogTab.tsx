import { useState } from 'react';
import { Box, Typography } from '@mui/joy';
import type { AuditEntry } from '@bike4mind/common';
import { useModelAdminLog } from '@client/app/hooks/data/adminModels';
import { getErrorMessage } from '@client/app/utils/error';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import { EmptyState, ErrorState, RelativeTime, SectionCard } from '../../../shared';
import { describeAuditEntry, fieldLabel, formatAuditValue } from '../../../Users/Profile/tabs/auditSentence';
import { TimelineList, TimelineSkeleton, type TimelineItem } from '../../../Users/Profile/tabs/TimelineList';

function ChangeList({ entry }: { entry: AuditEntry }) {
  const changes = entry.changes ?? [];
  if (changes.length === 0) return null;
  return (
    <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2, fontSize: 12, color: 'admin.inkMuted' }}>
      {changes.map(change => (
        <li key={change.field}>
          {fieldLabel(change.field)}: {formatAuditValue(change.before)} {'\u2192'} {formatAuditValue(change.after)}
        </li>
      ))}
    </Box>
  );
}

/** Admin changes to this model's access, prices and lifecycle suggestion, newest first; the raw entry opens on click. */
export function ModelAdminLogTab({ modelId }: { modelId: string }) {
  const log = useModelAdminLog(modelId);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const items = log.entries.map((entry): TimelineItem => ({
    id: entry.id,
    tile: { text: 'AD', tone: 'neutral' },
    summary: describeAuditEntry(entry),
    onOpen: () => setSelected(entry),
    meta: entry.reason ? `Reason: ${entry.reason}` : undefined,
    extra: <ChangeList entry={entry} />,
    aside: (
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        {entry.actor.name} {'\u00b7'} <RelativeTime at={entry.occurredAt} />
      </Typography>
    ),
  }));

  const body = () => {
    if (log.isLoading) return <TimelineSkeleton />;
    if (log.isError && items.length === 0) {
      return (
        <ErrorState
          message={`The admin log could not be loaded. ${getErrorMessage(log.error)}`}
          onRetry={() => void log.refetch()}
        />
      );
    }
    if (items.length === 0) {
      return (
        <EmptyState
          title="No admin changes yet"
          description="Access, price and lifecycle changes admins make to this model appear here."
          action={null}
        />
      );
    }
    return <TimelineList items={items} rowTestId="model-admin-log-row" data-testid="model-admin-log-list" />;
  };

  return (
    <>
      <SectionCard title="Admin actions on this model" body="custom" data-testid="model-admin-log">
        {body()}
        {(log.truncated || (log.isError && items.length > 0)) && (
          <Typography
            level="body-xs"
            sx={{ p: 2, borderTop: '1px solid', borderColor: 'admin.border', color: 'admin.inkMuted' }}
            data-testid="model-admin-log-partial"
          >
            {log.isError
              ? 'Part of the log could not be loaded. The entries above may be incomplete.'
              : 'Showing the latest changes. Older ones are in the audit log.'}
          </Typography>
        )}
      </SectionCard>
      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </>
  );
}
