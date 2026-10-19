import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AuditEntryDrawer } from './AuditEntryDrawer';
import { makeAuditEntry } from './auditTestFixtures';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('AuditEntryDrawer', () => {
  it('renders before/after for each change', () => {
    const entry = makeAuditEntry({
      changes: [
        { field: 'plan', before: 'free', after: 'pro' },
        { field: 'limits', before: { seats: 1 }, after: { seats: 5 } },
      ],
    });
    render(<AuditEntryDrawer entry={entry} onClose={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('free')).toBeTruthy();
    expect(screen.getByText('pro')).toBeTruthy();
    expect(screen.getByText('{"seats":1}')).toBeTruthy();
    expect(screen.getByText('{"seats":5}')).toBeTruthy();
  });

  it('renders nothing visible when entry is null', () => {
    render(<AuditEntryDrawer entry={null} onClose={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('audit-drawer')).toBeNull();
  });

  it('hides Related events when none are given', () => {
    const { rerender } = render(<AuditEntryDrawer entry={makeAuditEntry()} onClose={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    expect(screen.queryByText('Related events')).toBeNull();
    rerender(<AuditEntryDrawer entry={makeAuditEntry()} onClose={vi.fn()} relatedEntries={[]} />);
    expect(screen.queryByText('Related events')).toBeNull();
  });

  it('calls onSelectRelated', () => {
    const related = makeAuditEntry({ id: 'rel-1', summary: 'Related thing' });
    const onSelectRelated = vi.fn();
    render(
      <AuditEntryDrawer
        entry={makeAuditEntry()}
        onClose={vi.fn()}
        relatedEntries={[related]}
        onSelectRelated={onSelectRelated}
      />,
      { wrapper: TestWrapper }
    );
    fireEvent.click(screen.getByTestId('audit-drawer-related-row-rel-1'));
    expect(onSelectRelated).toHaveBeenCalledWith(related);
  });

  it('shows the open-in-log link only when href is given', () => {
    const { rerender } = render(<AuditEntryDrawer entry={makeAuditEntry()} onClose={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    expect(screen.queryByTestId('audit-drawer-open-in-log-link')).toBeNull();
    rerender(<AuditEntryDrawer entry={makeAuditEntry()} onClose={vi.fn()} openInAuditLogHref="/admin/audit?x=1" />);
    expect(screen.getByTestId('audit-drawer-open-in-log-link').getAttribute('href')).toBe('/admin/audit?x=1');
  });

  it('calls onClose from the close button', () => {
    const onClose = vi.fn();
    render(<AuditEntryDrawer entry={makeAuditEntry()} onClose={onClose} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('audit-drawer-close-btn'));
    expect(onClose).toHaveBeenCalled();
  });

  it('activates a related row with Enter', () => {
    const related = makeAuditEntry({ id: 'rel-1' });
    const onSelectRelated = vi.fn();
    render(
      <AuditEntryDrawer
        entry={makeAuditEntry()}
        onClose={vi.fn()}
        relatedEntries={[related]}
        onSelectRelated={onSelectRelated}
      />,
      { wrapper: TestWrapper }
    );
    const row = screen.getByTestId('audit-drawer-related-row-rel-1');
    expect(row.getAttribute('role')).toBe('button');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelectRelated).toHaveBeenCalledWith(related);
  });

  it('renders null and undefined before/after values without crashing', () => {
    const entry = makeAuditEntry({
      changes: [
        { field: 'note', before: null, after: undefined },
        { field: 'note', before: 'a', after: 'b' },
      ],
    });
    render(<AuditEntryDrawer entry={entry} onClose={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByText('null')).toBeTruthy();
    expect(screen.getAllByText('note')).toHaveLength(2);
  });
});
