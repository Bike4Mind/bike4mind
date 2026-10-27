import { useState, type ReactNode } from 'react';
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
      serverPagination: { page: 2, pageSize: 25, total: 101, onPageChange, onPageSizeChange },
    });
    expect(tableRows()).toHaveLength(25);
    expect(tableRows()[0]).toHaveAttribute('data-testid', 'admin-table-row-26');
    expect(screen.getByText('26-50 of 101')).toBeTruthy();
    expect(screen.queryByTestId('admin-table-sort-count-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByTestId('admin-table-previous-btn'));
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-50'));
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it('retains server pagination recovery controls on an empty page', () => {
    const onPageChange = vi.fn();
    renderTable({
      rows: [],
      serverPagination: { page: 3, pageSize: 25, total: 40, onPageChange, onPageSizeChange: vi.fn() },
    });
    expect(screen.getByTestId('admin-empty-state')).toBeTruthy();
    expect(screen.getByText('0-0 of 40')).toBeTruthy();
    expect(screen.getByTestId('admin-table-next-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('admin-table-previous-btn'));
    expect(onPageChange).toHaveBeenCalledWith(2);
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
});
