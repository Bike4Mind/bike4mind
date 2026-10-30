import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { DataTable, type DataColumn, type DataTableProps } from './DataTable';
import type { AdminSelection } from './BulkActionBar';

const theme = extendTheme({ ...getThemeConfig() });
type Row = { id: string; count: number };
const rows = Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1), count: 101 - index }));
const columns: DataColumn<Row>[] = [
  { id: 'count', label: 'Count', render: row => row.count, sortValue: row => row.count, numeric: true },
];
const defaults = { rows, columns, getRowId: (row: Row) => row.id, label: 'Accounts', onRetry: vi.fn() };
const renderTable = (props: Partial<DataTableProps<Row>> = {}) =>
  render(
    <CssVarsProvider theme={theme}>
      <DataTable {...defaults} {...props} />
    </CssVarsProvider>
  );
const tableRows = () => within(screen.getByTestId('admin-data-table')).getAllByRole('row').slice(1);

function StatefulTable({ children }: { children?: ReactNode }) {
  const [selection, setSelection] = useState<AdminSelection>({ mode: 'explicit', ids: [] });
  return (
    <CssVarsProvider theme={theme}>
      <DataTable {...defaults} selection={selection} onSelectionChange={setSelection} />
      {children}
    </CssVarsProvider>
  );
}

describe('DataTable', () => {
  it('renders a server page without slicing or locally sorting it', () => {
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();
    renderTable({
      rows: rows.slice(25, 50),
      selection: { mode: 'allMatching' },
      onSelectionChange: vi.fn(),
      pagination: { page: 2, pageSize: 25, total: 101, onPageChange, onPageSizeChange },
    });
    expect(tableRows()).toHaveLength(25);
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-26');
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('26 to 50 of 101');
    expect(screen.queryByTestId('admin-table-sort-count-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByTestId('admin-table-previous-btn'));
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-50'));
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it('offers a way back from an empty server page past the end', () => {
    const onPageChange = vi.fn();
    renderTable({
      rows: [],
      pagination: { page: 3, pageSize: 25, total: 40, onPageChange, onPageSizeChange: vi.fn() },
    });
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No records on this page');
    fireEvent.click(screen.getByTestId('admin-table-first-page-btn'));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('toggles the focused row with x, not inputs or modified keys', () => {
    render(<StatefulTable />);
    const row = screen.getByTestId('admin-table-row-1');
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'x', ctrlKey: true });
    expect(row).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(row, { key: 'x' });
    expect(row).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(within(screen.getByTestId('admin-table-select-1')).getByRole('checkbox'), { key: 'x' });
    expect(row).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(row, { key: 'x' });
    expect(row).toHaveAttribute('aria-selected', 'false');
  });

  it('renders every supplied row without local pagination when the caller owns paging', () => {
    renderTable({ pagination: false });
    expect(tableRows()).toHaveLength(101);
    expect(screen.queryByTestId('admin-table-page-size')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-previous-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-next-btn')).not.toBeInTheDocument();
  });

  it('paginates the complete result at 25, 50 and 100 rows', () => {
    renderTable();
    expect(tableRows()).toHaveLength(25);
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-26');
    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-50'));
    expect(tableRows()).toHaveLength(50);
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-1');
    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-100'));
    expect(tableRows()).toHaveLength(100);
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByTestId('admin-table-next-btn')).toBeDisabled();
  });

  it('sorts the whole result numerically and resets the page', () => {
    renderTable();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    fireEvent.click(screen.getByTestId('admin-table-sort-count-btn'));
    expect(tableRows()[0]).toHaveTextContent('1');
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-101');
    expect(screen.getByTestId('admin-table-sort-count-btn').closest('th')).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByTestId('admin-table-sort-count-btn'));
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-1');
    expect(screen.getByTestId('admin-table-sort-count-btn').closest('th')).toHaveAttribute('aria-sort', 'descending');
  });

  it('preserves selections across pages and toggles only visible rows', () => {
    render(<StatefulTable />);
    fireEvent.click(within(screen.getByTestId('admin-table-select-page')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(within(screen.getByTestId('admin-table-select-26')).getByRole('checkbox')).not.toBeChecked();
    fireEvent.click(within(screen.getByTestId('admin-table-select-26')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('admin-table-previous-btn'));
    expect(within(screen.getByTestId('admin-table-select-1')).getByRole('checkbox')).toBeChecked();
    fireEvent.click(within(screen.getByTestId('admin-table-select-page')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(within(screen.getByTestId('admin-table-select-26')).getByRole('checkbox')).toBeChecked();
  });

  it('deselects one row from all matching without dropping other pages', () => {
    const change = vi.fn();
    renderTable({ selection: { mode: 'allMatching' }, onSelectionChange: change });
    fireEvent.click(within(screen.getByTestId('admin-table-select-1')).getByRole('checkbox'));
    expect(change).toHaveBeenCalledWith({ mode: 'explicit', ids: rows.slice(1).map(row => row.id) });
  });

  it('activates rows with click and keyboard while isolating cell controls', () => {
    const activate = vi.fn();
    const cellClick = vi.fn();
    renderTable({
      onRowActivate: activate,
      columns: [
        {
          id: 'action',
          label: 'Action',
          render: row => (
            <button data-testid={`action-${row.id}`} onClick={cellClick}>
              Open
            </button>
          ),
        },
      ],
    });
    fireEvent.click(screen.getByTestId('admin-table-row-1'));
    fireEvent.keyDown(screen.getByTestId('admin-table-row-2'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByTestId('admin-table-row-3'), { key: ' ' });
    fireEvent.click(screen.getByTestId('action-1'));
    expect(activate.mock.calls.map(call => call[0].id)).toEqual(['1', '2', '3']);
    expect(cellClick).toHaveBeenCalledOnce();
  });

  it('ignores clicks from portalled cell content such as a row menu', () => {
    const activate = vi.fn();
    renderTable({
      onRowActivate: activate,
      columns: [
        {
          id: 'menu',
          label: 'Menu',
          render: row =>
            row.id === '1' &&
            createPortal(
              <>
                <div role="menuitem" data-testid="portal-item">
                  Approve
                </div>
                {/* Matches no CELL_CONTROLS selector, so only the contains() check stops it. */}
                <div data-testid="portal-popover">Details</div>
              </>,
              document.body
            ),
        },
      ],
    });
    fireEvent.click(screen.getByTestId('portal-item'));
    fireEvent.click(screen.getByTestId('portal-popover'));
    expect(activate).not.toHaveBeenCalled();
  });

  it('shows skeletons, actionable empty and actionable error states', () => {
    const retry = vi.fn();
    const rendered = renderTable({ loading: true, onRetry: retry });
    expect(screen.getAllByTestId('admin-table-skeleton-row')).toHaveLength(5);
    expect(screen.getByTestId('admin-table-next-btn')).toBeDisabled();
    rendered.rerender(
      <CssVarsProvider theme={theme}>
        <DataTable {...defaults} rows={[]} onRetry={retry} />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('admin-table-refresh-btn'));
    rendered.rerender(
      <CssVarsProvider theme={theme}>
        <DataTable {...defaults} error="Request failed" onRetry={retry} />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Request failed');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('clamps pagination when a filter shrinks the result', () => {
    const rendered = renderTable();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    rendered.rerender(
      <CssVarsProvider theme={theme}>
        <DataTable {...defaults} rows={rows.slice(0, 2)} />
      </CssVarsProvider>
    );
    expect(tableRows()).toHaveLength(2);
    expect(screen.getByTestId('admin-table-previous-btn')).toBeDisabled();
  });

  it('returns to the first page when the reset key changes', () => {
    const rendered = renderTable({ pageResetKey: 'all' });
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-51');
    rendered.rerender(
      <CssVarsProvider theme={theme}>
        <DataTable {...defaults} rows={rows.slice(0, 60)} pageResetKey="filtered" />
      </CssVarsProvider>
    );
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-1');
    expect(screen.getByTestId('admin-table-previous-btn')).toBeDisabled();
  });

  it('selects a range with Shift-click and toggles the focused row with x', () => {
    render(<StatefulTable />);
    fireEvent.click(within(screen.getByTestId('admin-table-select-2')).getByRole('checkbox'));
    fireEvent.click(within(screen.getByTestId('admin-table-select-5')).getByRole('checkbox'), { shiftKey: true });
    for (const id of ['2', '3', '4', '5']) {
      expect(within(screen.getByTestId(`admin-table-select-${id}`)).getByRole('checkbox')).toBeChecked();
    }
    expect(within(screen.getByTestId('admin-table-select-1')).getByRole('checkbox')).not.toBeChecked();
    expect(within(screen.getByTestId('admin-table-select-6')).getByRole('checkbox')).not.toBeChecked();

    fireEvent.keyDown(screen.getByTestId('admin-table-row-9'), { key: 'x' });
    expect(within(screen.getByTestId('admin-table-select-9')).getByRole('checkbox')).toBeChecked();
    fireEvent.keyDown(screen.getByTestId('admin-table-row-9'), { key: 'x' });
    expect(within(screen.getByTestId('admin-table-select-9')).getByRole('checkbox')).not.toBeChecked();
  });

  it('moves focus between rows with the arrow keys', () => {
    renderTable({ onRowActivate: vi.fn() });
    screen.getByTestId('admin-table-row-1').focus();
    fireEvent.keyDown(screen.getByTestId('admin-table-row-1'), { key: 'ArrowDown' });
    expect(screen.getByTestId('admin-table-row-2')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('admin-table-row-2'), { key: 'ArrowUp' });
    expect(screen.getByTestId('admin-table-row-1')).toHaveFocus();
  });

  it('delegates paging and sorting to the server when controlled', () => {
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();
    const onSortChange = vi.fn();
    renderTable({
      rows: rows.slice(25, 50),
      columns: [{ id: 'count', label: 'Count', render: row => row.count, sortable: true, numeric: true }],
      sort: { columnId: 'count', direction: 'asc' },
      onSortChange,
      pagination: { page: 2, pageSize: 25, total: 1204, onPageChange, onPageSizeChange },
    });
    expect(tableRows()).toHaveLength(25);
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-26');
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('26 to 50 of 1,204');
    expect(screen.getByTestId('admin-table-sort-count-btn').closest('th')).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByTestId('admin-table-sort-count-btn'));
    expect(onSortChange).toHaveBeenCalledWith({ columnId: 'count', direction: 'desc' });
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-100'));
    expect(onPageSizeChange).toHaveBeenCalledWith(100);
  });

  it('renders group headers with their rows first, in page order, and the rest after', () => {
    renderTable({
      rows: rows.slice(0, 5),
      groups: [{ id: 'bots', header: <span>bots.example</span>, rowIds: ['4', '2'] }],
    });
    expect(screen.getByTestId('admin-table-group-bots')).toHaveTextContent('bots.example');
    const order = within(screen.getByTestId('admin-data-table'))
      .getAllByRole('row')
      .slice(1)
      .map(row => row.getAttribute('data-testid'));
    expect(order).toEqual([
      'admin-table-group-bots',
      'admin-table-row-2',
      'admin-table-row-4',
      'admin-table-row-1',
      'admin-table-row-3',
      'admin-table-row-5',
    ]);
  });

  it('renders row actions without activating the row', () => {
    const activate = vi.fn();
    const action = vi.fn();
    renderTable({
      rows: rows.slice(0, 2),
      onRowActivate: activate,
      rowActions: row => (
        <button data-testid={`row-menu-${row.id}`} onClick={action}>
          More
        </button>
      ),
    });
    fireEvent.click(screen.getByTestId('row-menu-1'));
    expect(action).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
  });
});
