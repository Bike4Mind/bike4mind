import { Box, Button, Chip, IconButton, Sheet, Stack, Table, Tooltip, Typography } from '@mui/joy';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import type { AuditEntry, AuditTarget } from '@bike4mind/common';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { activateOnKey } from './activateOnKey';
import { AuditActorLabel } from './AuditActorLabel';
import { AuditSeverityChip } from './AuditSeverityChip';

export type AuditEventTableProps = {
  entries: AuditEntry[];
  isLoading: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore(): void;
  onSelectEntry(entry: AuditEntry): void;
  /** Omitted = actor is not clickable. */
  onFilterActor?(actorUserId: string): void;
  /** Omitted = target is not clickable. */
  onFilterTarget?(target: { kind: AuditTarget['kind']; id: string }): void;
  emptyMessage?: string;
};

const COLUMN_COUNT = 6;

type FilterButtonProps = { testId: string; label: string; onClick(): void };

const FilterButton: React.FC<FilterButtonProps> = ({ testId, label, onClick }) => (
  <Tooltip title={label}>
    <IconButton
      size="sm"
      variant="plain"
      aria-label={label}
      data-testid={testId}
      // The row itself opens the drawer; a filter click must not.
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
    >
      <FilterAltOutlinedIcon fontSize="small" />
    </IconButton>
  </Tooltip>
);

const AuditRow: React.FC<
  { entry: AuditEntry } & Pick<AuditEventTableProps, 'onSelectEntry' | 'onFilterActor' | 'onFilterTarget'>
> = ({ entry, onSelectEntry, onFilterActor, onFilterTarget }) => {
  const occurredAt = new Date(entry.occurredAt);
  const { userId } = entry.actor;

  return (
    <tr
      data-testid={`audit-table-row-${entry.id}`}
      onClick={() => onSelectEntry(entry)}
      tabIndex={0}
      onKeyDown={activateOnKey(() => onSelectEntry(entry))}
      style={{ cursor: 'pointer' }}
    >
      <td>
        <Tooltip title={occurredAt.toLocaleString()}>
          <Typography level="body-sm" noWrap>
            {relativeTimeFormat(occurredAt)}
          </Typography>
        </Tooltip>
      </td>
      <td>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <AuditActorLabel actor={entry.actor} />
          {onFilterActor && userId && (
            <FilterButton
              testId="audit-table-actor-filter-btn"
              label="Filter by this actor"
              onClick={() => onFilterActor(userId)}
            />
          )}
        </Stack>
      </td>
      <td>
        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
          <Typography level="body-sm">{entry.summary}</Typography>
          {entry.source !== 'admin' && (
            <Chip size="sm" variant="outlined" data-testid="audit-table-source-chip">
              {entry.source}
            </Chip>
          )}
          {entry.backfilled && (
            <Chip size="sm" variant="outlined" color="neutral" data-testid="audit-table-backfilled-chip">
              Backfilled
            </Chip>
          )}
        </Stack>
      </td>
      <td>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography level="body-sm" noWrap>
            {entry.target.displayName}
          </Typography>
          {onFilterTarget && (
            <FilterButton
              testId="audit-table-target-filter-btn"
              label="Filter by this target"
              onClick={() => onFilterTarget({ kind: entry.target.kind, id: entry.target.id })}
            />
          )}
        </Stack>
      </td>
      <td>
        <Typography
          level="body-sm"
          title={entry.reason}
          sx={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {entry.reason ?? ''}
        </Typography>
      </td>
      <td>
        <AuditSeverityChip severity={entry.severity} />
      </td>
    </tr>
  );
};

export const AuditEventTable: React.FC<AuditEventTableProps> = ({
  entries,
  isLoading,
  hasMore,
  isFetchingMore,
  onLoadMore,
  onSelectEntry,
  onFilterActor,
  onFilterTarget,
  emptyMessage = 'No audit events found',
}) => (
  <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
    <Table
      hoverRow
      stickyHeader
      data-testid="audit-table"
      sx={{ '& tbody tr:focus-visible': { outline: '2px solid', outlineColor: 'primary.500', outlineOffset: -2 } }}
    >
      <thead>
        <tr>
          <th style={{ width: 120 }}>Time</th>
          <th>Actor</th>
          <th>Summary</th>
          <th>Target</th>
          <th>Reason</th>
          <th style={{ width: 100 }}>Severity</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(entry => (
          <AuditRow
            key={entry.id}
            entry={entry}
            onSelectEntry={onSelectEntry}
            onFilterActor={onFilterActor}
            onFilterTarget={onFilterTarget}
          />
        ))}
        {!isLoading && entries.length === 0 && (
          <tr data-testid="audit-table-empty">
            <td colSpan={COLUMN_COUNT}>
              <Typography level="body-sm" textAlign="center" sx={{ py: 3 }}>
                {emptyMessage}
              </Typography>
            </td>
          </tr>
        )}
      </tbody>
    </Table>
    {hasMore && (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 1.5 }}>
        <Button
          variant="outlined"
          color="neutral"
          loading={isFetchingMore}
          onClick={onLoadMore}
          data-testid="audit-table-load-more-btn"
        >
          Load more
        </Button>
      </Box>
    )}
  </Sheet>
);
