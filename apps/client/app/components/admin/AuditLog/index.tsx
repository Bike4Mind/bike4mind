import { useEffect, useMemo, useState } from 'react';
import { Alert, Stack } from '@mui/joy';
import { AdminPageHeader } from '../shared/AdminPageHeader';
import type { AuditEntry, AuditLogFilters, AuditSummaryWindow } from '@bike4mind/common';
import { useSnackbar } from '@client/app/contexts/SnackbarContext';
import { useAuditAlertStatus, useAuditEntry, useAuditLog } from '@client/app/hooks/data/adminAuditLog';
import { AuditEntryDrawer, AuditEventTable } from './shared';
import { AuditFilterBar } from './AuditFilterBar';
import { AuditNeedsReviewPanel } from './AuditNeedsReviewPanel';
import { AuditSavedViewChips } from './AuditSavedViewChips';
import { AuditSummaryStrip } from './AuditSummaryStrip';
import { useAuditLogSearchParams } from './useAuditLogSearchParams';

const RELATED_EVENTS_LIMIT = 20;
const LIST_ERROR_MESSAGE = 'Could not load audit events. Refresh to try again.';
const ENTRY_UNAVAILABLE_MESSAGE = 'That audit entry could not be loaded.';
const NO_FILTERS: AuditLogFilters = {};
const DEFAULT_SUMMARY_WINDOW: AuditSummaryWindow = 30;

const relatedFiltersFor = (entry: AuditEntry | null | undefined): AuditLogFilters | null => {
  const impersonationSessionId = entry?.related?.impersonationSessionId;
  const requestId = entry?.context.requestId;
  if (impersonationSessionId) return { impersonationSessionId };
  if (requestId) return { requestId };
  return null;
};

const AuditLogPage: React.FC = () => {
  const { filters, entryId, setFilters, patchFilters, openEntry } = useAuditLogSearchParams();
  const { showSnackbar } = useSnackbar();
  const [windowDays, setWindowDays] = useState<AuditSummaryWindow>(DEFAULT_SUMMARY_WINDOW);
  const { data: alertStatus } = useAuditAlertStatus();
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = useAuditLog(filters);

  const entries = useMemo(() => data?.pages.flatMap(page => page.entries) ?? [], [data]);
  const loadedEntry = useMemo(
    () => (entryId ? entries.find(entry => entry.id === entryId) : undefined),
    [entries, entryId]
  );
  const { data: drawerEntry, isError: isEntryError } = useAuditEntry(entryId, loadedEntry);

  // A deep link to a missing entry would otherwise leave a drawer that never opens; a failed
  // background refetch of an entry already on screen must not close it.
  useEffect(() => {
    if (!entryId || !isEntryError || drawerEntry) return;
    showSnackbar(ENTRY_UNAVAILABLE_MESSAGE, { variant: 'soft', color: 'warning' });
    openEntry(null);
  }, [drawerEntry, entryId, isEntryError, openEntry, showSnackbar]);

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
      <AdminPageHeader title="Audit log" description="Review recorded changes, their actors and reasons." />
      {alertStatus && !alertStatus.alertsEnabled && (
        <Alert color="warning" variant="soft" data-testid="audit-alerts-off-banner">
          Security alerts are off: critical entries are not posted to Slack. Set the Security Alerts Channel Webhook URL
          in Admin Settings to turn them on.
        </Alert>
      )}
      <AuditSummaryStrip windowDays={windowDays} onWindowChange={setWindowDays} onApply={setFilters} />
      <AuditNeedsReviewPanel
        windowDays={windowDays}
        alertStatus={alertStatus}
        onSelectEntry={entry => openEntry(entry.id)}
      />
      <AuditSavedViewChips filters={filters} onSelect={setFilters} />
      <AuditFilterBar filters={filters} onChange={patchFilters} onClear={() => setFilters({})} />
      <AuditEventTable
        entries={entries}
        pageResetKey={JSON.stringify(filters)}
        isLoading={isLoading}
        errorMessage={isError ? LIST_ERROR_MESSAGE : undefined}
        hasMore={Boolean(hasNextPage)}
        isFetchingMore={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        onRetry={() => void refetch()}
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
