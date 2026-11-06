import type { ReactNode } from 'react';
import { Box, Button, Chip, IconButton, Link, Stack, Tooltip, Typography } from '@mui/joy';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import type { AuditEntry, AuditTarget } from '@bike4mind/common';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { DataTable, EmptyState, ErrorState, type AdminSelection, type DataColumn } from '../../shared';
import { AuditActorLabel } from './AuditActorLabel';
import { AuditKeyDetails, AuditSelfTargetedChip } from './AuditEntryHighlights';
import { AuditSeverityChip } from './AuditSeverityChip';
import { auditTargetHref } from './auditTargetHref';

export type AuditEventTableProps<T extends AuditEntry = AuditEntry> = {
  entries: T[];
  isLoading: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore(): void;
  onRetry?(): void;
  onSelectEntry(entry: T): void;
  onFilterActor?(actorUserId: string): void;
  onFilterTarget?(target: { kind: AuditTarget['kind']; id: string }): void;
  emptyMessage?: string;
  errorMessage?: string;
  testIdPrefix?: string;
  pageResetKey?: string;
  /** Row selection; both props are needed to turn it on. */
  selection?: AdminSelection;
  onSelectionChange?(selection: AdminSelection): void;
  rowActions?(entry: T): ReactNode;
  /** Inserted before the Severity column. */
  extraColumns?: DataColumn<T>[];
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

export const AuditEventTable = <T extends AuditEntry = AuditEntry>({
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
  selection,
  onSelectionChange,
  rowActions,
  extraColumns = [],
}: AuditEventTableProps<T>) => {
  const retry = onRetry ?? onLoadMore;
  const columns: DataColumn<T>[] = [
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
        <Stack spacing={0.5}>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
            <Typography level="body-sm">{entry.summary}</Typography>
            <AuditSelfTargetedChip entry={entry} testIdPrefix={testIdPrefix} />
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
          <AuditKeyDetails entry={entry} testIdPrefix={testIdPrefix} />
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
      // Reasons can run to a paragraph; the row shows two lines and the drawer shows the rest.
      render: entry => (
        <Typography
          level="body-sm"
          title={entry.reason || undefined}
          data-testid={`${testIdPrefix}-reason`}
          sx={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            overflowWrap: 'anywhere',
            maxWidth: 360,
          }}
        >
          {entry.reason || 'No reason recorded'}
        </Typography>
      ),
    },
    ...extraColumns,
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
        selection={selection}
        onSelectionChange={onSelectionChange}
        rowActions={rowActions}
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
