import { useMemo } from 'react';
import { Stack, Typography } from '@mui/joy';
import type { AuditEntry, AuditLogFilters } from '@bike4mind/common';
import { useAuditEntry, useAuditLog } from '@client/app/hooks/data/adminAuditLog';
import { AuditEntryDrawer, AuditEventTable } from './shared';
import { AuditFilterBar } from './AuditFilterBar';
import { AuditSavedViewChips } from './AuditSavedViewChips';
import { AuditSummaryStrip } from './AuditSummaryStrip';
import { useAuditLogSearchParams } from './useAuditLogSearchParams';

const RELATED_EVENTS_LIMIT = 20;
const NO_FILTERS: AuditLogFilters = {};

const relatedFiltersFor = (entry: AuditEntry | null | undefined): AuditLogFilters | null => {
  const impersonationSessionId = entry?.related?.impersonationSessionId;
  const requestId = entry?.context.requestId;
  if (impersonationSessionId) return { impersonationSessionId };
  if (requestId) return { requestId };
  return null;
};

const AuditLogPage: React.FC = () => {
  const { filters, entryId, setFilters, patchFilters, openEntry } = useAuditLogSearchParams();
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useAuditLog(filters);

  const entries = useMemo(() => data?.pages.flatMap(page => page.entries) ?? [], [data]);
  const loadedEntry = useMemo(
    () => (entryId ? entries.find(entry => entry.id === entryId) : undefined),
    [entries, entryId]
  );
  const { data: drawerEntry } = useAuditEntry(entryId, loadedEntry);

  const relatedFilters = relatedFiltersFor(drawerEntry);
  const { data: relatedData } = useAuditLog(relatedFilters ?? NO_FILTERS, {
    enabled: entryId !== null && relatedFilters !== null,
    limit: RELATED_EVENTS_LIMIT,
  });
  const relatedEntries = useMemo(
    () =>
      relatedFilters
        ? (relatedData?.pages.flatMap(page => page.entries) ?? []).filter(entry => entry.id !== drawerEntry?.id)
        : [],
    [relatedData, relatedFilters, drawerEntry?.id]
  );

  return (
    <Stack spacing={2} sx={{ p: { xs: 1, sm: 2 } }} data-testid="audit-log-page">
      <Typography level="title-lg">Audit Log</Typography>
      <AuditSummaryStrip onApply={setFilters} />
      <AuditSavedViewChips filters={filters} onSelect={setFilters} />
      <AuditFilterBar filters={filters} onChange={patchFilters} onClear={() => setFilters({})} />
      <AuditEventTable
        entries={entries}
        isLoading={isLoading}
        hasMore={Boolean(hasNextPage)}
        isFetchingMore={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        onSelectEntry={entry => openEntry(entry.id)}
        onFilterActor={actorUserId => patchFilters({ actorUserId })}
        onFilterTarget={({ kind, id }) => patchFilters({ targetKind: kind, targetId: id })}
      />
      <AuditEntryDrawer
        entry={drawerEntry ?? null}
        onClose={() => openEntry(null)}
        relatedEntries={relatedEntries}
        onSelectRelated={entry => openEntry(entry.id)}
      />
    </Stack>
  );
};

export default AuditLogPage;
