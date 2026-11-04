import { useMemo, useState } from 'react';
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import { BulkActionBar, EmptyState, SectionCard, SegmentedControl, useUndoToast } from '../shared';
import type { AdminSelection, DataColumn } from '../shared';
import CheckIcon from '@mui/icons-material/Check';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import {
  AUDIT_REVIEW_BATCH_MAX,
  auditReviewConflict,
  isFullAdmin,
  type AuditAlertStatus,
  type AuditEntry,
  type AuditReviewQueueEntry,
  type AuditSummaryWindow,
  type MarkAuditReviewedResult,
  type MarkAuditReviewedSkipReason,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useAuditReviewQueue,
  useAuditSummary,
  useMarkAuditReviewed,
  useUnmarkAuditReviewed,
} from '@client/app/hooks/data/adminAuditLog';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { AuditEventTable } from './shared';

const PAGE_SIZE = 50;
const LIST_ERROR_MESSAGE = 'Could not load entries that need review.';
const TO_REVIEW_HINT =
  'Critical actions by other admins, waiting for a second pair of eyes. Your own actions go to another admin.';
const NOT_FULL_ADMIN_HINT = 'Only full admins can sign off on critical entries.';

type ReviewView = 'to-review' | 'all';
const VIEW_OPTIONS: { value: ReviewView; label: string }[] = [
  { value: 'to-review', label: 'To review' },
  { value: 'all', label: 'All critical' },
];

const noSelection: AdminSelection = { mode: 'explicit', ids: [] };

const formatCredits = (credits: number) => credits.toLocaleString('en-US');

const describeCriticalRules = (alertStatus: AuditAlertStatus | undefined): string => {
  const grants = alertStatus
    ? `credit grants above ${formatCredits(alertStatus.singleGrantCredits)} credits or past ` +
      `${formatCredits(alertStatus.dailyGrantCredits)} credits per admin in 24 hours`
    : 'credit grants above the configured thresholds';
  return `Critical entries: admin role changes, impersonation, suspensions, deletions, denied self-actions, and ${grants}.`;
};

type AuditNeedsReviewPanelProps = {
  windowDays: AuditSummaryWindow;
  alertStatus: AuditAlertStatus | undefined;
  onSelectEntry(entry: AuditEntry): void;
};

const pluralize = (count: number, singular: string, plural: string) => (count === 1 ? singular : plural);

const describeSkips = (skipped: MarkAuditReviewedResult['skipped']): string => {
  const counts = new Map<MarkAuditReviewedSkipReason, number>();
  for (const { reason } of skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const phrase = (reason: MarkAuditReviewedSkipReason, count: number): string => {
    const verb = pluralize(count, 'was', 'were');
    switch (reason) {
      case 'already_reviewed':
        return `${count} ${verb} already reviewed`;
      case 'own_action':
        return `${count} ${verb} your own ${pluralize(count, 'action', 'actions')}`;
      case 'about_you':
        return `${count} ${verb} about your own account`;
      case 'not_critical':
        return `${count} ${verb} not critical`;
      case 'not_found':
        return `${count} could not be found`;
    }
  };
  return [...counts].map(([reason, count]) => phrase(reason, count)).join(', ');
};

const chunk = <T,>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const ReviewStatusCell: React.FC<{ entry: AuditReviewQueueEntry; currentUserId: string | undefined }> = ({
  entry,
  currentUserId,
}) => {
  const { review } = entry;
  const testId = `audit-needs-review-status-${entry.id}`;
  if (review?.baseline)
    return (
      <Chip size="sm" variant="outlined" data-testid={testId}>
        Baselined
      </Chip>
    );
  if (review)
    return (
      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
        <Chip size="sm" variant="soft" color="success" data-testid={testId}>
          Reviewed
        </Chip>
        <Typography level="body-xs">
          by {review.reviewer.name}, {relativeTimeFormat(review.reviewedAt)}
        </Typography>
      </Stack>
    );
  const conflict = currentUserId ? auditReviewConflict(entry, currentUserId) : null;
  if (conflict)
    return (
      <Chip size="sm" variant="outlined" data-testid={testId}>
        {conflict === 'own_action' ? 'Your action' : 'About you'}
      </Chip>
    );
  return (
    <Chip size="sm" variant="soft" color="warning" data-testid={testId}>
      Not reviewed
    </Chip>
  );
};

/**
 * Review queue for critical entries. "To review" is every unreviewed critical entry another admin performed
 * that is not about the viewer;
 * "All critical" is the summary window with each entry's sign-off state.
 */
export const AuditNeedsReviewPanel: React.FC<AuditNeedsReviewPanelProps> = ({
  windowDays,
  alertStatus,
  onSelectEntry,
}) => {
  const { currentUser } = useUser();
  const showUndo = useUndoToast();
  const mark = useMarkAuditReviewed();
  const unmark = useUnmarkAuditReviewed();
  const canReview = isFullAdmin(currentUser);
  const [view, setView] = useState<ReviewView>('to-review');
  const [selection, setSelection] = useState<AdminSelection>(noSelection);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

  // The summary's `since` is stable while cached; a Date.now()-derived bound would re-key the list every render.
  const { data: summary, isError: summaryError } = useAuditSummary(windowDays);
  const toReviewQuery = useAuditReviewQueue('unreviewed', { limit: PAGE_SIZE });
  const allQuery = useAuditReviewQueue('all', {
    from: summary?.since,
    limit: PAGE_SIZE,
    enabled: view === 'all' && summary !== undefined,
  });
  const active = view === 'to-review' ? toReviewQuery : allQuery;
  const waitingForSummary = view === 'all' && summary === undefined && !summaryError;
  const isLoading = active.isLoading || waitingForSummary;
  const isError = active.isError || (view === 'all' && summaryError);

  const entries = useMemo(() => active.data?.pages.flatMap(page => page.entries) ?? [], [active.data]);
  const total = toReviewQuery.data?.pages.at(-1)?.total;
  const hasToReview = total !== undefined && total > 0;

  const selectionEnabled = canReview && view === 'to-review';
  const selectedIds = useMemo(() => {
    if (!selectionEnabled) return [];
    const loadedIds = entries.map(entry => entry.id);
    if (selection.mode === 'allMatching') return loadedIds;
    return loadedIds.filter(id => selection.ids.includes(id));
  }, [entries, selection, selectionEnabled]);

  const expanded = userExpanded ?? (total === undefined || total > 0);
  // `total` is the server's count of every unreviewed entry, not just the loaded pages.
  const countLabel = `${(total ?? 0).toLocaleString('en-US')} to review`;
  const toReviewEmpty = view === 'to-review' && !isLoading && !isError && entries.length === 0;

  const switchView = (next: ReviewView) => {
    setView(next);
    setSelection(noSelection);
  };

  const markReviewed = async (ids: string[]) => {
    const result: MarkAuditReviewedResult = { reviewed: [], skipped: [] };
    try {
      for (const batch of chunk(ids, AUDIT_REVIEW_BATCH_MAX)) {
        const batchResult = await mark.mutateAsync({ entryIds: batch });
        result.reviewed.push(...batchResult.reviewed);
        result.skipped.push(...batchResult.skipped);
      }
    } catch {
      // The mutation's onError already told the admin what to do; keep the selection so they can retry.
      return;
    }
    setSelection(noSelection);
    const { reviewed, skipped } = result;
    const skippedNote = skipped.length > 0 ? ` ${describeSkips(skipped)}.` : '';
    if (reviewed.length === 0) {
      showUndo({ message: `Nothing was marked as reviewed.${skippedNote}` });
      return;
    }
    showUndo({
      message: `Marked ${reviewed.length} as reviewed.${skippedNote}`,
      onUndo: async () => {
        for (const batch of chunk(reviewed, AUDIT_REVIEW_BATCH_MAX)) await unmark.mutateAsync({ entryIds: batch });
      },
    });
  };

  const rowActions = (entry: AuditReviewQueueEntry) => (
    <Tooltip title="Mark as reviewed">
      <IconButton
        size="sm"
        variant="plain"
        aria-label="Mark as reviewed"
        disabled={mark.isPending}
        data-testid="audit-needs-review-row-mark-btn"
        onClick={event => {
          event.stopPropagation();
          void markReviewed([entry.id]);
        }}
      >
        <CheckIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );

  const reviewColumn: DataColumn<AuditReviewQueueEntry> = {
    id: 'review',
    label: 'Review',
    render: entry => <ReviewStatusCell entry={entry} currentUserId={currentUser?.id} />,
  };

  return (
    <Box data-testid="audit-needs-review-panel">
      <SectionCard
        title="Needs review"
        body="custom"
        action={
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <SegmentedControl
              options={VIEW_OPTIONS}
              value={view}
              onChange={switchView}
              aria-label="Needs review view"
              data-testid="audit-needs-review-view"
            />
            {total !== undefined && !toReviewQuery.isError && (
              <Chip
                size="sm"
                variant="soft"
                color={hasToReview ? 'danger' : 'neutral'}
                data-testid="audit-needs-review-count"
              >
                {hasToReview ? countLabel : 'Nothing to review'}
              </Chip>
            )}
            <IconButton
              size="sm"
              variant="plain"
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse needs review' : 'Expand needs review'}
              onClick={() => setUserExpanded(!expanded)}
              data-testid="audit-needs-review-toggle-btn"
            >
              {expanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
            </IconButton>
          </Stack>
        }
      >
        {expanded && (
          <Box sx={{ px: 2, py: 1.5 }}>
            <Stack spacing={0.5} sx={{ mb: 1 }}>
              {view === 'to-review' && (
                <Typography level="body-sm" data-testid="audit-needs-review-hint">
                  {TO_REVIEW_HINT}
                </Typography>
              )}
              <Typography level="body-xs">{describeCriticalRules(alertStatus)}</Typography>
              {view === 'to-review' && !canReview && (
                <Typography level="body-xs" data-testid="audit-needs-review-not-full-admin">
                  {NOT_FULL_ADMIN_HINT}
                </Typography>
              )}
            </Stack>
            {toReviewEmpty ? (
              <Box data-testid="audit-needs-review-table-empty">
                <EmptyState
                  title="Nothing waiting for review"
                  description="Critical actions by other admins show up here until one of you signs off."
                  action={
                    <Button
                      variant="outlined"
                      onClick={() => switchView('all')}
                      data-testid="audit-needs-review-show-all-btn"
                    >
                      Show all critical
                    </Button>
                  }
                />
              </Box>
            ) : (
              <AuditEventTable<AuditReviewQueueEntry>
                testIdPrefix="audit-needs-review-table"
                entries={entries}
                pageResetKey={view}
                isLoading={isLoading}
                errorMessage={isError ? LIST_ERROR_MESSAGE : undefined}
                emptyMessage={`No critical entries in the last ${windowDays} days`}
                hasMore={Boolean(active.hasNextPage)}
                isFetchingMore={active.isFetchingNextPage}
                onLoadMore={() => void active.fetchNextPage()}
                onRetry={() => void active.refetch()}
                onSelectEntry={onSelectEntry}
                selection={selectionEnabled ? selection : undefined}
                onSelectionChange={selectionEnabled ? setSelection : undefined}
                rowActions={selectionEnabled ? rowActions : undefined}
                extraColumns={view === 'all' ? [reviewColumn] : undefined}
              />
            )}
            {selectionEnabled && (
              <BulkActionBar
                selection={selection}
                totalMatching={entries.length}
                onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
                onClear={() => setSelection(noSelection)}
              >
                <Button
                  variant="outlined"
                  loading={mark.isPending}
                  disabled={selectedIds.length === 0}
                  onClick={() => void markReviewed(selectedIds)}
                  data-testid="audit-needs-review-bulk-mark-btn"
                >
                  Mark {selectedIds.length} as reviewed
                </Button>
              </BulkActionBar>
            )}
          </Box>
        )}
      </SectionCard>
    </Box>
  );
};
