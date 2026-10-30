import { Box, Button, Chip, IconButton, Link, Stack, Tooltip, Typography } from '@mui/joy';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import type { AuditEntry, AuditTarget } from '@bike4mind/common';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { DataTable, EmptyState, ErrorState, type DataColumn } from '../../shared';
import { AuditActorLabel } from './AuditActorLabel';
import { AuditSeverityChip } from './AuditSeverityChip';
import { auditTargetHref } from './auditTargetHref';

export type AuditEventTableProps = {
  entries: AuditEntry[];
  isLoading: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore(): void;
  onRetry?(): void;
  onSelectEntry(entry: AuditEntry): void;
  onFilterActor?(actorUserId: string): void;
  onFilterTarget?(target: { kind: AuditTarget['kind']; id: string }): void;
  emptyMessage?: string;
  errorMessage?: string;
  testIdPrefix?: string;
  pageResetKey?: string;
};

const FilterButton = ({ testId, label, onClick }: { testId: string; label: string; onClick(): void }) => (
  <Tooltip title={label}>
    <IconButton
      size="sm"
      variant="plain"
      aria-label={label}
      data-testid={testId}
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
    >
      <FilterAltOutlinedIcon fontSize="small" />
    </IconButton>
  </Tooltip>
);

export const AuditEventTable: React.FC<AuditEventTableProps> = ({
  entries,
  isLoading,
  hasMore,
  isFetchingMore,
  onLoadMore,
  onRetry,
  onSelectEntry,
  onFilterActor,
  onFilterTarget,
  emptyMessage = 'No audit events found',
  errorMessage,
  testIdPrefix = 'audit-table',
  pageResetKey,
}) => {
  const retry = onRetry ?? onLoadMore;
  const columns: DataColumn<AuditEntry>[] = [
    {
      id: 'time',
      label: 'Time',
      render: entry => (
        <Tooltip title={new Date(entry.occurredAt).toUTCString()}>
          <Typography level="body-sm" noWrap>
            {relativeTimeFormat(new Date(entry.occurredAt))}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'actor',
      label: 'Actor',
      render: entry => (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <AuditActorLabel actor={entry.actor} />
          {onFilterActor && entry.actor.userId && (
            <FilterButton
              testId={`${testIdPrefix}-actor-filter-btn`}
              label="Filter by this actor"
              onClick={() => onFilterActor(entry.actor.userId!)}
            />
          )}
        </Stack>
      ),
    },
    {
      id: 'summary',
      label: 'Summary',
      render: entry => (
        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
          <Typography level="body-sm">{entry.summary}</Typography>
          {entry.source !== 'admin' && (
            <Chip size="sm" variant="outlined" data-testid={`${testIdPrefix}-source-chip`}>
              {entry.source}
            </Chip>
          )}
          {entry.backfilled && (
            <Chip size="sm" variant="outlined" data-testid={`${testIdPrefix}-backfilled-chip`}>
              Backfilled
            </Chip>
          )}
        </Stack>
      ),
    },
    {
      id: 'target',
      label: 'Target',
      render: entry => {
        const href = auditTargetHref(entry.target);
        return (
          <Stack direction="row" spacing={0.5} alignItems="center">
            {href ? (
              <Link href={href} data-testid={`${testIdPrefix}-target-link`}>
                {entry.target.displayName}
              </Link>
            ) : (
              <Typography level="body-sm">{entry.target.displayName}</Typography>
            )}
            {onFilterTarget && (
              <FilterButton
                testId={`${testIdPrefix}-target-filter-btn`}
                label="Filter by this target"
                onClick={() => onFilterTarget({ kind: entry.target.kind, id: entry.target.id })}
              />
            )}
          </Stack>
        );
      },
    },
    {
      id: 'reason',
      label: 'Reason',
      render: entry => <Typography level="body-sm">{entry.reason || 'No reason recorded'}</Typography>,
    },
    { id: 'severity', label: 'Severity', render: entry => <AuditSeverityChip severity={entry.severity} /> },
  ];

  if (errorMessage)
    return (
      <Box data-testid={`${testIdPrefix}-error`}>
        <ErrorState message={errorMessage} onRetry={retry} />
      </Box>
    );

  return (
    <Stack spacing={1} data-testid={isLoading && entries.length === 0 ? `${testIdPrefix}-loading` : undefined}>
      <DataTable
        rows={entries}
        columns={columns}
        getRowId={entry => entry.id}
        label="Audit events"
        testId={testIdPrefix}
        rowTestId={entry => `${testIdPrefix}-row-${entry.id}`}
        loading={isLoading && entries.length === 0}
        onRetry={retry}
        onRowActivate={onSelectEntry}
        pageResetKey={pageResetKey}
        empty={
          <Box data-testid={`${testIdPrefix}-empty`}>
            <EmptyState
              title={emptyMessage}
              action={
                <Button variant="outlined" onClick={retry} data-testid={`${testIdPrefix}-refresh-btn`}>
                  Refresh events
                </Button>
              }
            />
          </Box>
        }
      />
      {hasMore && (
        <Stack direction="row" justifyContent="center" spacing={1} alignItems="center">
          <Typography level="body-sm">More events are available.</Typography>
          <Button
            variant="outlined"
            loading={isFetchingMore}
            onClick={onLoadMore}
            data-testid={`${testIdPrefix}-load-more-btn`}
          >
            Load more
          </Button>
        </Stack>
      )}
    </Stack>
  );
};
