import { Fragment, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Box, Button, Checkbox, IconButton, Option, Select, Skeleton, Stack, Table, Typography } from '@mui/joy';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { adminFocus, adminFocusScope, adminScrollGutter, adminSurface } from './adminStyles';
import type { AdminSelection } from './BulkActionBar';

export type DataColumn<Row> = {
  id: string;
  label: string;
  render: (row: Row) => ReactNode;
  /** Sorts the loaded rows locally. Ignored when the table's sort is controlled. */
  sortValue?: (row: Row) => string | number;
  /** With a controlled sort: the server can order by this column. */
  sortable?: boolean;
  numeric?: boolean;
  /** CSS width of the column, e.g. '8rem'. */
  width?: string;
};
export type DataTableSort = { columnId: string; direction: 'asc' | 'desc' };
/** Server pagination: `rows` is already the current page. `page` is 1-based. */
export type DataTablePagination = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};
/** A header row followed by its rows. Rows in no group render last, without a header. */
export type DataTableGroup = { id: string; header: ReactNode; rowIds: readonly string[] };
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
  /** Changing this (e.g. the serialized filter state) returns the table to its first page. */
  pageResetKey?: string;
  /** Controlled sort; with it, rows are shown in the order given. */
  sort?: DataTableSort;
  onSortChange?: (sort: DataTableSort) => void;
  /** `false` shows every row with no footer, for callers that page with their own controls. */
  pagination?: DataTablePagination | false;
  groups?: readonly DataTableGroup[];
  /** Ghost controls in a trailing cell, shown while the row is hovered or holds focus. */
  rowActions?: (row: Row) => ReactNode;
  /** Below this width the table scrolls sideways instead of squeezing columns. */
  minWidth?: string;
  /** Cap with an inner scroll; `none` lets the page scroll instead. */
  maxHeight?: string;
};
const PAGE_SIZES = [25, 50, 100] as const;
const CELL_CONTROLS = 'button, input, a, [role="checkbox"], [role="menu"], [role="menuitem"]';

function nextDirection(current: DataTableSort | undefined, columnId: string): DataTableSort {
  return { columnId, direction: current?.columnId === columnId && current.direction === 'asc' ? 'desc' : 'asc' };
}

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
  pageResetKey,
  sort: controlledSort,
  onSortChange,
  pagination: paginationProp,
  groups,
  rowActions,
  minWidth = '40rem',
  maxHeight = '65vh',
}: DataTableProps<Row>) {
  const [localSort, setLocalSort] = useState<DataTableSort>();
  const [localPage, setLocalPage] = useState(0);
  const [pagedResetKey, setPagedResetKey] = useState(pageResetKey);
  if (pagedResetKey !== pageResetKey) {
    setPagedResetKey(pageResetKey);
    setLocalPage(0);
  }
  const [localPageSize, setLocalPageSize] = useState<number>(25);
  // The last row toggled by hand: a Shift-click selects everything between it and the clicked row.
  const rangeAnchor = useRef<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const sortControlled = onSortChange !== undefined;
  // A server page is an incomplete result, so sorting it locally would mislead: only a controlled sort applies.
  const localSortable = !sortControlled && !paginationProp;
  const sort = sortControlled ? controlledSort : localSort;
  const sortedColumn = localSortable ? columns.find(column => column.id === sort?.columnId) : undefined;
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

  const pagination = paginationProp || undefined;
  const pageSize = pagination?.pageSize ?? localPageSize;
  const total = pagination?.total ?? rows.length;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const currentPage = pagination ? Math.min(pagination.page - 1, lastPage) : Math.min(localPage, lastPage);
  const pageRows =
    pagination || paginationProp === false
      ? sorted
      : sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const goToPage = (page: number) => (pagination ? pagination.onPageChange(page + 1) : setLocalPage(page));

  const sections = groupSections(pageRows, getRowId, groups);
  const visibleRows = sections.flatMap(section => section.rows);
  const visibleIds = visibleRows.map(getRowId);

  const selectable = selection !== undefined && onSelectionChange !== undefined;
  const isSelected = (id: string) => selection?.mode === 'allMatching' || (selection?.ids.includes(id) ?? false);
  const selectedVisible = visibleIds.filter(isSelected).length;
  const toggleRows = (ids: readonly string[], checked: boolean) => {
    // Deselecting from all-matching converts the loaded rows to an explicit selection.
    const previousIds = selection?.mode === 'allMatching' ? rows.map(getRowId) : (selection?.ids ?? []);
    const next = new Set(previousIds);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    onSelectionChange?.({ mode: 'explicit', ids: [...next] });
  };
  const toggleRow = (id: string, checked: boolean, extendRange: boolean) => {
    const anchorIndex = rangeAnchor.current ? visibleIds.indexOf(rangeAnchor.current) : -1;
    const index = visibleIds.indexOf(id);
    rangeAnchor.current = id;
    if (!extendRange || anchorIndex < 0) return toggleRows([id], checked);
    const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
    toggleRows(visibleIds.slice(from, to + 1), checked);
  };

  const changeSort = (columnId: string) => {
    const next = nextDirection(sort, columnId);
    if (sortControlled) onSortChange(next);
    else setLocalSort(next);
    goToPage(0);
  };
  const isSortable = (column: DataColumn<Row>) =>
    sortControlled ? column.sortable === true : localSortable && !!column.sortValue;

  const focusSiblingRow = (row: HTMLElement, step: 1 | -1) => {
    const all = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('tr[data-row-id]') ?? []);
    all[all.indexOf(row) + step]?.focus();
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: Row, id: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusSiblingRow(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
    } else if (
      event.key.toLowerCase() === 'x' &&
      selectable &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.repeat &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      toggleRow(id, !isSelected(id), event.shiftKey);
    } else if (onRowActivate && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onRowActivate(row);
    }
  };
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, row: Row) => {
    const target = event.target as HTMLElement;
    // Portalled cell content (a menu, a popover) bubbles here through React but sits outside the row.
    if (!event.currentTarget.contains(target) || target.closest(CELL_CONTROLS)) return;
    onRowActivate?.(row);
  };

  const columnCount = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);
  if (error) {
    const onFirstPage = pagination && pagination.page > 1 ? () => pagination.onPageChange(1) : undefined;
    return <ErrorState message={error} onRetry={onRetry} onFirstPage={onFirstPage} />;
  }
  if (!loading && rows.length === 0) {
    // An empty server page past the last record (e.g. after rows were removed) needs a way back.
    if (pagination && pagination.total > 0 && pagination.page > 1)
      return (
        <EmptyState
          title="No records on this page"
          action={
            <Button
              variant="outlined"
              onClick={() => pagination.onPageChange(1)}
              data-testid="admin-table-first-page-btn"
            >
              Back to the first page
            </Button>
          }
        />
      );
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
  }

  const firstShown = total === 0 ? 0 : currentPage * pageSize + 1;
  const lastShown = pagination
    ? currentPage * pageSize + pageRows.length
    : Math.min((currentPage + 1) * pageSize, total);
  return (
    <Box
      sx={{ ...adminSurface, ...adminFocusScope, borderWidth: 1, borderStyle: 'solid', overflow: 'hidden' }}
      data-testid={`${testId}-frame`}
    >
      <Box
        role="region"
        aria-label={label}
        // Tells the admin skin this table already has its own frame (adminSkin.ts, JoyTable).
        data-admin-table-frame
        tabIndex={0}
        sx={{
          ...adminFocus,
          overflowX: 'auto',
          maxHeight: maxHeight === 'none' ? undefined : maxHeight,
          ...adminScrollGutter,
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
            minWidth,
            '--TableCell-selectedBackground': 'var(--joy-palette-admin-selection-background)',
            '--TableRow-hoverBackground': 'var(--joy-palette-admin-surfaceSubtle)',
            '--TableCell-headBackground': 'var(--joy-palette-admin-surfaceSubtle)',
            '--TableCell-paddingX': '12px',
            '& th, & td': { borderColor: 'admin.border', color: 'admin.ink', verticalAlign: 'middle' },
            '& thead th': { height: 38, color: 'admin.inkMuted', fontSize: 12, fontWeight: 500 },
            '& tbody tr[data-row-id] td': { height: 56 },
            '& tbody tr[data-row-id]:focus-visible': {
              outline: '2px solid var(--joy-palette-admin-accent)',
              outlineOffset: -2,
            },
            '& [data-row-actions]': { opacity: 0, transition: 'opacity 120ms' },
            '& tr:hover [data-row-actions], & tr:focus-within [data-row-actions]': { opacity: 1 },
            '@media (hover: none)': { '& [data-row-actions]': { opacity: 1 } },
          }}
        >
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: '2.75rem' }}>
                  <Checkbox
                    size="sm"
                    aria-label="Select page"
                    data-testid="admin-table-select-page"
                    checked={visibleRows.length > 0 && selectedVisible === visibleRows.length}
                    indeterminate={selectedVisible > 0 && selectedVisible < visibleRows.length}
                    disabled={loading}
                    onChange={event => toggleRows(visibleIds, event.target.checked)}
                  />
                </th>
              )}
              {columns.map(column => (
                <th
                  key={column.id}
                  aria-sort={
                    isSortable(column)
                      ? sort?.columnId === column.id
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                  style={{ textAlign: column.numeric ? 'right' : 'left', width: column.width }}
                >
                  {isSortable(column) ? (
                    <Button
                      size="sm"
                      variant="plain"
                      sx={{
                        ...adminFocus,
                        color: sort?.columnId === column.id ? 'admin.ink' : 'admin.inkMuted',
                        fontSize: 12,
                        fontWeight: 500,
                        minHeight: 0,
                        px: 0.5,
                        mx: -0.5,
                      }}
                      data-testid={`admin-table-sort-${column.id}-btn`}
                      onClick={() => changeSort(column.id)}
                    >
                      {column.label}
                      {sort?.columnId === column.id && (sort.direction === 'asc' ? ' \u2191' : ' \u2193')}
                    </Button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
              {rowActions && <th style={{ width: '3.5rem' }} aria-label="Row actions" />}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {loading
              ? Array.from({ length: pagination ? Math.min(pageSize, 8) : 5 }, (_, index) => (
                  <tr key={index} data-testid="admin-table-skeleton-row">
                    {Array.from({ length: columnCount }, (_, cell) => (
                      <td key={cell} style={{ height: 56 }}>
                        <Skeleton variant="text" />
                      </td>
                    ))}
                  </tr>
                ))
              : sections.map(section => (
                  <Fragment key={section.id}>
                    {section.header !== undefined && (
                      <tr data-testid={`admin-table-group-${section.id}`}>
                        <td colSpan={columnCount} style={{ padding: 0 }}>
                          {section.header}
                        </td>
                      </tr>
                    )}
                    {section.rows.map(row => {
                      const id = getRowId(row);
                      return (
                        <tr
                          key={id}
                          data-row-id={id}
                          tabIndex={onRowActivate || selectable ? 0 : undefined}
                          aria-keyshortcuts={selectable ? 'x' : undefined}
                          aria-selected={selectable ? isSelected(id) : activeRowId === id}
                          data-testid={rowTestId?.(row) ?? `admin-table-row-${id}`}
                          onClick={event => onRowClick(event, row)}
                          onKeyDown={event => onRowKeyDown(event, row, id)}
                          style={{ cursor: onRowActivate ? 'pointer' : undefined }}
                        >
                          {selectable && (
                            <td>
                              <Checkbox
                                size="sm"
                                aria-label={`Select ${id}`}
                                data-testid={`admin-table-select-${id}`}
                                checked={isSelected(id)}
                                onChange={event =>
                                  toggleRow(
                                    id,
                                    event.target.checked,
                                    (event.nativeEvent as globalThis.MouseEvent).shiftKey
                                  )
                                }
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
                          {rowActions && (
                            <td style={{ textAlign: 'right' }}>
                              <Box data-row-actions sx={{ display: 'inline-flex', gap: 0.5 }}>
                                {rowActions(row)}
                              </Box>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
          </tbody>
        </Table>
      </Box>
      {paginationProp !== false && (
        <Stack
          direction="row"
          alignItems="center"
          flexWrap="wrap"
          gap={1.5}
          sx={{ px: 1.5, py: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
          data-testid="admin-table-footer"
        >
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mr: 'auto' }} data-testid="admin-table-range">
            {firstShown.toLocaleString()} to {lastShown.toLocaleString()} of {total.toLocaleString()}
          </Typography>
          <Typography
            level="body-sm"
            sx={{ color: 'admin.inkMuted' }}
            component="span"
            id={`${testId}-page-size-label`}
          >
            Rows per page
          </Typography>
          <Select
            aria-labelledby={`${testId}-page-size-label`}
            size="sm"
            value={pageSize}
            disabled={loading}
            data-testid="admin-table-page-size"
            onChange={(_, value) => {
              if (value === null) return;
              if (pagination) pagination.onPageSizeChange(value);
              else {
                setLocalPageSize(value);
                setLocalPage(0);
              }
            }}
          >
            {PAGE_SIZES.map(size => (
              <Option key={size} value={size} data-testid={`admin-table-page-size-${size}`}>
                {size}
              </Option>
            ))}
          </Select>
          <Stack direction="row" gap={0.5}>
            <IconButton
              size="sm"
              variant="outlined"
              aria-label="Previous page"
              disabled={loading || currentPage === 0}
              onClick={() => goToPage(currentPage - 1)}
              data-testid="admin-table-previous-btn"
            >
              <ChevronLeftIcon />
            </IconButton>
            <IconButton
              size="sm"
              variant="outlined"
              aria-label="Next page"
              disabled={loading || currentPage === lastPage}
              onClick={() => goToPage(currentPage + 1)}
              data-testid="admin-table-next-btn"
            >
              <ChevronRightIcon />
            </IconButton>
          </Stack>
        </Stack>
      )}
    </Box>
  );
}

type Section<Row> = { id: string; header?: ReactNode; rows: Row[] };

/**
 * Splits the page into the given groups, in their order, then a headerless section for the rest.
 * Rows keep page order inside a group so a group never overrides the requested sort.
 */
function groupSections<Row>(
  rows: readonly Row[],
  getRowId: (row: Row) => string,
  groups: readonly DataTableGroup[] | undefined
): Section<Row>[] {
  if (!groups) return [{ id: 'all', rows: [...rows] }];
  const placed = new Set<string>();
  const sections: Section<Row>[] = [];
  for (const group of groups) {
    const members = new Set(group.rowIds);
    const groupRows = rows.filter(row => {
      const id = getRowId(row);
      if (!members.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
    if (groupRows.length > 0) sections.push({ id: group.id, header: group.header, rows: groupRows });
  }
  const rest = rows.filter(row => !placed.has(getRowId(row)));
  if (rest.length > 0) sections.push({ id: 'ungrouped', rows: rest });
  return sections;
}
