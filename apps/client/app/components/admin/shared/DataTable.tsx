import { useState, type ReactNode } from 'react';
import { Box, Button, Checkbox, Option, Select, Skeleton, Stack, Table, Typography } from '@mui/joy';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { adminFocus, adminFocusScope, adminSurface } from './adminStyles';
import type { AdminSelection } from './BulkActionBar';

export type DataColumn<Row> = {
  id: string;
  label: string;
  render: (row: Row) => ReactNode;
  sortValue?: (row: Row) => string | number;
  numeric?: boolean;
};
export type DataTableProps<Row> = {
  rows: readonly Row[];
  columns: readonly DataColumn<Row>[];
  getRowId: (row: Row) => string;
  label: string;
  loading?: boolean;
  error?: string;
  onRetry: () => void;
  empty?: ReactNode;
  selection?: AdminSelection;
  onSelectionChange?: (selection: AdminSelection) => void;
  onRowActivate?: (row: Row) => void;
  activeRowId?: string;
  testId?: string;
  rowTestId?: (row: Row) => string;
  /** Disable when the caller paginates rows on the server. */
  pagination?: boolean;
  /** Changing this (e.g. the serialized filter state) returns the table to its first page. */
  pageResetKey?: string;
};
type Sort = { columnId: string; direction: 'asc' | 'desc' };
const PAGE_SIZES = [25, 50, 100] as const;

export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  label,
  loading,
  error,
  onRetry,
  empty,
  selection,
  onSelectionChange,
  onRowActivate,
  activeRowId,
  testId = 'admin-data-table',
  rowTestId,
  pagination = true,
  pageResetKey,
}: DataTableProps<Row>) {
  const [sort, setSort] = useState<Sort>();
  const [page, setPage] = useState(0);
  const [pagedResetKey, setPagedResetKey] = useState(pageResetKey);
  if (pagedResetKey !== pageResetKey) {
    setPagedResetKey(pageResetKey);
    setPage(0);
  }
  const [pageSize, setPageSize] = useState<number>(25);
  const sortedColumn = columns.find(column => column.id === sort?.columnId);
  const sorted = sortedColumn?.sortValue
    ? [...rows].sort((left, right) => {
        const leftValue = sortedColumn.sortValue!(left);
        const rightValue = sortedColumn.sortValue!(right);
        const result =
          typeof leftValue === 'number' && typeof rightValue === 'number'
            ? leftValue - rightValue
            : String(leftValue).localeCompare(String(rightValue));
        return sort?.direction === 'desc' ? -result : result;
      })
    : rows;
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleRows = pagination ? sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize) : sorted;
  const selectable = selection !== undefined && onSelectionChange !== undefined;
  const isSelected = (id: string) => selection?.mode === 'allMatching' || (selection?.ids.includes(id) ?? false);
  const selectedVisible = visibleRows.filter(row => isSelected(getRowId(row))).length;
  const toggleRows = (ids: string[], checked: boolean) => {
    // Deselecting from all-matching converts the complete loaded result to an explicit selection.
    const previousIds = selection?.mode === 'allMatching' ? rows.map(getRowId) : (selection?.ids ?? []);
    const next = new Set(previousIds);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    onSelectionChange?.({ mode: 'explicit', ids: [...next] });
  };
  const changeSort = (columnId: string) => {
    setSort(previous => ({
      columnId,
      direction: previous?.columnId === columnId && previous.direction === 'asc' ? 'desc' : 'asc',
    }));
    setPage(0);
  };
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!loading && rows.length === 0)
    return (
      empty ?? (
        <EmptyState
          title="No records to show"
          action={
            <Button variant="outlined" onClick={onRetry} data-testid="admin-table-refresh-btn">
              Refresh records
            </Button>
          }
        />
      )
    );
  return (
    <Stack gap={1} sx={adminFocusScope}>
      <Box
        role="region"
        aria-label={label}
        // Tells the admin skin this table already has its own frame (adminSkin.ts, JoyTable).
        data-admin-table-frame
        tabIndex={0}
        sx={{
          ...adminSurface,
          ...adminFocus,
          overflowX: 'auto',
          maxHeight: '65vh',
          borderWidth: 1,
          borderStyle: 'solid',
        }}
      >
        <Table
          stickyHeader
          hoverRow
          size="sm"
          aria-label={label}
          aria-busy={loading || undefined}
          data-testid={testId}
          sx={{
            minWidth: '40rem',
            '--TableCell-selectedBackground': 'var(--joy-palette-admin-canvas)',
            '& th, & td': { borderColor: 'admin.border', color: 'admin.ink' },
            '& th': { color: 'admin.inkMuted' },
          }}
        >
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: '3rem' }}>
                  <Checkbox
                    aria-label="Select page"
                    data-testid="admin-table-select-page"
                    checked={visibleRows.length > 0 && selectedVisible === visibleRows.length}
                    indeterminate={selectedVisible > 0 && selectedVisible < visibleRows.length}
                    disabled={loading}
                    onChange={event => toggleRows(visibleRows.map(getRowId), event.target.checked)}
                  />
                </th>
              )}
              {columns.map(column => (
                <th
                  key={column.id}
                  aria-sort={
                    column.sortValue
                      ? sort?.columnId === column.id
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                  style={{ textAlign: column.numeric ? 'right' : 'left' }}
                >
                  {column.sortValue ? (
                    <Button
                      size="sm"
                      variant="plain"
                      sx={{ ...adminFocus, color: 'admin.inkMuted' }}
                      data-testid={`admin-table-sort-${column.id}-btn`}
                      onClick={() => changeSort(column.id)}
                    >
                      {column.label}
                      {sort?.columnId === column.id && (sort.direction === 'asc' ? ' +' : ' -')}
                    </Button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }, (_, index) => (
                  <tr key={index} data-testid="admin-table-skeleton-row">
                    {Array.from({ length: columns.length + (selectable ? 1 : 0) }, (_, cell) => (
                      <td key={cell}>
                        <Skeleton variant="text" />
                      </td>
                    ))}
                  </tr>
                ))
              : visibleRows.map(row => {
                  const id = getRowId(row);
                  return (
                    <tr
                      key={id}
                      tabIndex={onRowActivate ? 0 : undefined}
                      aria-selected={selectable ? isSelected(id) : activeRowId === id}
                      data-testid={rowTestId?.(row) ?? `admin-table-row-${id}`}
                      onClick={event => {
                        if ((event.target as HTMLElement).closest('button, input, a, [role="checkbox"]')) return;
                        onRowActivate?.(row);
                      }}
                      onKeyDown={event => {
                        if (
                          event.target !== event.currentTarget ||
                          !onRowActivate ||
                          (event.key !== 'Enter' && event.key !== ' ')
                        )
                          return;
                        event.preventDefault();
                        onRowActivate(row);
                      }}
                      style={{ cursor: onRowActivate ? 'pointer' : undefined }}
                    >
                      {selectable && (
                        <td>
                          <Checkbox
                            aria-label={`Select ${id}`}
                            data-testid={`admin-table-select-${id}`}
                            checked={isSelected(id)}
                            onChange={event => toggleRows([id], event.target.checked)}
                          />
                        </td>
                      )}
                      {columns.map(column => (
                        <td
                          key={column.id}
                          style={{
                            textAlign: column.numeric ? 'right' : 'left',
                            fontVariantNumeric: column.numeric ? 'tabular-nums' : undefined,
                          }}
                        >
                          {column.render(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </Table>
      </Box>
      {pagination && (
        <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            {rows.length === 0 ? 0 : currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, rows.length)}{' '}
            of {rows.length.toLocaleString()}
          </Typography>
          <Select
            aria-label="Rows per page"
            size="sm"
            value={pageSize}
            disabled={loading}
            data-testid="admin-table-page-size"
            onChange={(_, value) => {
              if (value !== null) {
                setPageSize(value);
                setPage(0);
              }
            }}
          >
            {PAGE_SIZES.map(size => (
              <Option key={size} value={size} data-testid={`admin-table-page-size-${size}`}>
                {size}
              </Option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="outlined"
            disabled={loading || currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
            data-testid="admin-table-previous-btn"
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outlined"
            disabled={loading || currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
            data-testid="admin-table-next-btn"
          >
            Next
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
