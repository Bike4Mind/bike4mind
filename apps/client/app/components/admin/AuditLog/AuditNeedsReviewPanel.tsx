import { useMemo, useState } from 'react';
import { Box, Chip, IconButton, Stack, Typography } from '@mui/joy';
import { SectionCard } from '../shared';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import type { AuditAlertStatus, AuditEntry, AuditLogFilters, AuditSummaryWindow } from '@bike4mind/common';
import { useAuditLog, useAuditSummary } from '@client/app/hooks/data/adminAuditLog';
import { AuditEventTable } from './shared';

const PAGE_SIZE = 10;
const LIST_ERROR_MESSAGE = 'Could not load entries that need review.';

const formatCredits = (credits: number) => credits.toLocaleString('en-US');

const describeCriticalRules = (alertStatus: AuditAlertStatus | undefined): string => {
  const grants = alertStatus
    ? `credit grants above ${formatCredits(alertStatus.singleGrantCredits)} credits or past ` +
      `${formatCredits(alertStatus.dailyGrantCredits)} credits per admin in 24 hours`
    : 'credit grants above the configured thresholds';
  return `Critical entries: admin role changes, impersonation, deletions, denied self-actions, and ${grants}.`;
};

type AuditNeedsReviewPanelProps = {
  windowDays: AuditSummaryWindow;
  alertStatus: AuditAlertStatus | undefined;
  onSelectEntry(entry: AuditEntry): void;
};

/** Critical entries in the summary window. Collapsed while there are none, until the admin opens it. */
export const AuditNeedsReviewPanel: React.FC<AuditNeedsReviewPanelProps> = ({
  windowDays,
  alertStatus,
  onSelectEntry,
}) => {
  // The summary's `since` is stable while cached; a Date.now()-derived bound would re-key the list every render.
  const { data: summary } = useAuditSummary(windowDays);
  const filters: AuditLogFilters = { severity: 'critical', from: summary?.since };
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = useAuditLog(filters, {
    enabled: summary !== undefined,
    limit: PAGE_SIZE,
  });
  const entries = useMemo(() => data?.pages.flatMap(page => page.entries) ?? [], [data]);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

  const isEmpty = !isLoading && !isError && entries.length === 0;
  const expanded = userExpanded ?? !isEmpty;
  const countLabel = `${entries.length}${hasNextPage ? '+' : ''}`;

  return (
    <Box data-testid="audit-needs-review-panel">
      <SectionCard title="Needs review">
        <Stack direction="row" spacing={1} alignItems="center">
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
          {summary && !isError && (
            <Chip
              size="sm"
              variant="soft"
              color={isEmpty ? 'neutral' : 'danger'}
              data-testid="audit-needs-review-count"
            >
              {isEmpty ? `Nothing critical in ${windowDays} days` : `${countLabel} critical in ${windowDays} days`}
            </Chip>
          )}
        </Stack>
        {expanded && (
          <Box>
            <Typography level="body-xs" sx={{ mb: 1 }}>
              {describeCriticalRules(alertStatus)}
            </Typography>
            <AuditEventTable
              testIdPrefix="audit-needs-review-table"
              entries={entries}
              pageResetKey={JSON.stringify(filters)}
              isLoading={isLoading}
              errorMessage={isError ? LIST_ERROR_MESSAGE : undefined}
              emptyMessage={`No critical entries in the last ${windowDays} days`}
              hasMore={Boolean(hasNextPage)}
              isFetchingMore={isFetchingNextPage}
              onLoadMore={() => void fetchNextPage()}
              onRetry={() => void refetch()}
              onSelectEntry={onSelectEntry}
            />
          </Box>
        )}
      </SectionCard>
    </Box>
  );
};
