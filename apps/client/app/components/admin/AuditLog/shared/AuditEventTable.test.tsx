import { render, screen, fireEvent } from '@testing-library/react';
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
});
