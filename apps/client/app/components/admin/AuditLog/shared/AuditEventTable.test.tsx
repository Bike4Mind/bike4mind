import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AuditEventTable } from './AuditEventTable';
import { makeAuditEntry } from './auditTestFixtures';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseProps = {
  entries: [makeAuditEntry(), makeAuditEntry({ id: 'entry-2', summary: 'Second' })],
  isLoading: false,
  hasMore: true,
  isFetchingMore: false,
  onLoadMore: vi.fn(),
  onSelectEntry: vi.fn(),
};

describe('AuditEventTable', () => {
  it('renders one row per entry and calls onSelectEntry on click', () => {
    const onSelectEntry = vi.fn();
    render(<AuditEventTable {...baseProps} onSelectEntry={onSelectEntry} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-table-row-entry-1')).toBeTruthy();
    expect(screen.getByTestId('audit-table-row-entry-2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('audit-table-row-entry-2'));
    expect(onSelectEntry).toHaveBeenCalledWith(baseProps.entries[1]);
  });

  it('renders an actor without userId as plain text', () => {
    const erased = makeAuditEntry({
      actor: { kind: 'user', scope: 'platform', name: 'Erased user', wasAdmin: false },
    });
    render(<AuditEventTable {...baseProps} entries={[erased]} onFilterActor={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    expect(screen.getByText('Erased user')).toBeTruthy();
    expect(screen.queryByTestId('audit-table-actor-filter-btn')).toBeNull();
  });

  it('links the affected record without opening its audit drawer', () => {
    const onSelectEntry = vi.fn();
    render(<AuditEventTable {...baseProps} entries={[makeAuditEntry()]} onSelectEntry={onSelectEntry} />, {
      wrapper: TestWrapper,
    });
    const link = screen.getByTestId('audit-table-target-link');
    expect(link).toHaveAttribute('href', '/admin/users/user-1');
    fireEvent.click(link);
    expect(onSelectEntry).not.toHaveBeenCalled();
  });

  it('shows recorded reasons and paginates the loaded events', () => {
    const entries = Array.from({ length: 26 }, (_, index) =>
      makeAuditEntry({ id: `entry-${index}`, reason: `Recorded reason ${index}` })
    );
    render(<AuditEventTable {...baseProps} entries={entries} />, { wrapper: TestWrapper });
    expect(screen.getByText('Recorded reason 0')).toBeVisible();
    expect(screen.queryByTestId('audit-table-row-entry-25')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(screen.getByTestId('audit-table-row-entry-25')).toBeVisible();
  });

  it('puts the full reason on the clamped cell title, and none on a missing reason', () => {
    const longReason = 'Escalated after repeated failed sign-ins from a new region. '.repeat(6).trim();
    const entries = [
      makeAuditEntry({ id: 'entry-long', reason: longReason }),
      makeAuditEntry({ id: 'entry-none', reason: undefined }),
    ];
    render(<AuditEventTable {...baseProps} entries={entries} />, { wrapper: TestWrapper });
    const [withReason, withoutReason] = screen.getAllByTestId('audit-table-reason');
    expect(withReason).toHaveAttribute('title', longReason);
    expect(withoutReason.textContent).toBe('No reason recorded');
    expect(withoutReason).not.toHaveAttribute('title');
  });

  it('retries a failed query rather than loading the next cursor', () => {
    const onRetry = vi.fn();
    const onLoadMore = vi.fn();
    render(<AuditEventTable {...baseProps} errorMessage="Could not load" onRetry={onRetry} onLoadMore={onLoadMore} />, {
      wrapper: TestWrapper,
    });
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('offers actor and target filters only when handlers are given', () => {
    const onFilterActor = vi.fn();
    const onFilterTarget = vi.fn();
    const { rerender } = render(<AuditEventTable {...baseProps} entries={[makeAuditEntry()]} />, {
      wrapper: TestWrapper,
    });
    expect(screen.queryByTestId('audit-table-actor-filter-btn')).toBeNull();
    expect(screen.queryByTestId('audit-table-target-filter-btn')).toBeNull();
    rerender(
      <AuditEventTable
        {...baseProps}
        entries={[makeAuditEntry()]}
        onFilterActor={onFilterActor}
        onFilterTarget={onFilterTarget}
      />
    );
    fireEvent.click(screen.getByTestId('audit-table-actor-filter-btn'));
    fireEvent.click(screen.getByTestId('audit-table-target-filter-btn'));
    expect(onFilterActor).toHaveBeenCalledWith('admin-1');
    expect(onFilterTarget).toHaveBeenCalledWith({ kind: 'user', id: 'user-1' });
    expect(baseProps.onSelectEntry).not.toHaveBeenCalled();
  });

  it('shows the impersonation badge and the non-admin source marker', () => {
    const entry = makeAuditEntry({
      source: 'apiKey',
      actor: {
        kind: 'user',
        scope: 'platform',
        userId: 'admin-1',
        name: 'Alice Admin',
        wasAdmin: true,
        impersonatedUserId: 'user-9',
      },
    });
    render(<AuditEventTable {...baseProps} entries={[entry]} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-actor-impersonation-chip')).toBeTruthy();
    expect(screen.getByTestId('audit-table-source-chip').textContent).toBe('apiKey');
  });

  it('calls onLoadMore when the load-more button is clicked', () => {
    const onLoadMore = vi.fn();
    render(<AuditEventTable {...baseProps} onLoadMore={onLoadMore} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('audit-table-load-more-btn'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('hides load more when hasMore is false', () => {
    const { rerender } = render(<AuditEventTable {...baseProps} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-table-load-more-btn')).toBeTruthy();
    rerender(<AuditEventTable {...baseProps} hasMore={false} />);
    expect(screen.queryByTestId('audit-table-load-more-btn')).toBeNull();
  });

  it('shows the empty message when there are no entries', () => {
    render(<AuditEventTable {...baseProps} entries={[]} hasMore={false} emptyMessage="Nothing here" />, {
      wrapper: TestWrapper,
    });
    expect(screen.getByTestId('audit-table-empty').textContent).toContain('Nothing here');
  });

  it('shows a danger alert instead of rows, empty state and load more when errorMessage is set', () => {
    render(<AuditEventTable {...baseProps} errorMessage="Could not load" />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-table-error').textContent).toContain('Could not load');
    expect(screen.queryByTestId('audit-table-row-entry-1')).toBeNull();
    expect(screen.queryByTestId('audit-table-empty')).toBeNull();
    expect(screen.queryByTestId('audit-table-load-more-btn')).toBeNull();
  });

  it('shows a loading indicator instead of the empty state while the first page loads', () => {
    render(<AuditEventTable {...baseProps} entries={[]} hasMore={false} isLoading />, { wrapper: TestWrapper });
    expect(screen.getByTestId('audit-table-loading')).toBeTruthy();
    expect(screen.queryByTestId('audit-table-empty')).toBeNull();
  });

  it('opens an entry with Enter or Space on a focused row, but not from a nested filter button', () => {
    const onSelectEntry = vi.fn();
    render(<AuditEventTable {...baseProps} onSelectEntry={onSelectEntry} onFilterActor={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    const row = screen.getByTestId('audit-table-row-entry-1');
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onSelectEntry).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getAllByTestId('audit-table-actor-filter-btn')[0], { key: 'Enter' });
    expect(onSelectEntry).toHaveBeenCalledTimes(2);
  });

  it('renders extra columns before Severity and trailing row actions without opening the entry', () => {
    const onSelectEntry = vi.fn();
    const onAction = vi.fn();
    render(
      <AuditEventTable
        {...baseProps}
        onSelectEntry={onSelectEntry}
        extraColumns={[{ id: 'extra', label: 'Extra', render: entry => `extra-${entry.id}` }]}
        rowActions={entry => (
          <button type="button" data-testid={`row-action-${entry.id}`} onClick={() => onAction(entry.id)}>
            Act
          </button>
        )}
      />,
      { wrapper: TestWrapper }
    );
    const headers = screen.getAllByRole('columnheader').map(header => header.textContent);
    expect(headers.indexOf('Extra')).toBe(headers.indexOf('Severity') - 1);
    expect(screen.getByText('extra-entry-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('row-action-entry-1'));
    expect(onAction).toHaveBeenCalledWith('entry-1');
    expect(onSelectEntry).not.toHaveBeenCalled();
  });

  it('selects rows when selection props are given', () => {
    const onSelectionChange = vi.fn();
    render(
      <AuditEventTable
        {...baseProps}
        selection={{ mode: 'explicit', ids: [] }}
        onSelectionChange={onSelectionChange}
      />,
      { wrapper: TestWrapper }
    );
    fireEvent.click(within(screen.getByTestId('audit-table-row-entry-1')).getByRole('checkbox'));
    expect(onSelectionChange).toHaveBeenCalledWith({ mode: 'explicit', ids: ['entry-1'] });
  });
});
