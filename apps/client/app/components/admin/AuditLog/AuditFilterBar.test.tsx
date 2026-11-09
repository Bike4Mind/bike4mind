import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AuditFilterBar, dateInputToIso, isoToDateInput } from './AuditFilterBar';

const user = vi.hoisted(() => ({ current: { isAdmin: true } as { isAdmin: boolean; adminPermissions?: string[] } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));
vi.mock('@client/app/hooks/data/adminAuditLog', () => ({ downloadAuditLogCsv: vi.fn() }));
vi.mock('@client/app/contexts/SnackbarContext', () => ({ useSnackbar: () => ({ showSnackbar: vi.fn() }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({ data: { data: [] }, isLoading: false }),
}));
vi.mock('@client/app/components/admin/shared/UserSelector', () => ({
  default: ({ label }: { label: string }) => <div data-testid={`mock-user-selector-${label}`} />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const actionInput = (): HTMLInputElement =>
  screen.getByTestId('audit-filter-action').querySelector('input') as HTMLInputElement;

describe('AuditFilterBar action filter', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    onChange.mockReset();
  });

  it('commits typed free text when the field loses focus', () => {
    render(<AuditFilterBar filters={{}} onChange={onChange} onClear={vi.fn()} />, { wrapper: TestWrapper });
    const input = actionInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'custom.thing' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ action: 'custom.thing' });
  });

  it('does not re-apply an unchanged action on blur', () => {
    render(<AuditFilterBar filters={{ action: 'user.deleted' }} onChange={onChange} onClear={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    const input = actionInput();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('date range conversion', () => {
  it('maps the start of a local calendar day to its first millisecond', () => {
    const iso = dateInputToIso('2026-10-01', 'start');
    expect(iso).toBe(new Date('2026-10-01T00:00:00.000').toISOString());
    expect(new Date(iso as string).getHours()).toBe(0);
  });

  it('maps the end of a local calendar day to its last millisecond, keeping the day inclusive', () => {
    const iso = dateInputToIso('2026-10-01', 'end');
    expect(iso).toBe(new Date('2026-10-01T23:59:59.999').toISOString());
    const end = new Date(iso as string);
    expect(end.getDate()).toBe(1);
    expect(end.getHours()).toBe(23);
  });

  it('returns undefined for an empty or unparseable date', () => {
    expect(dateInputToIso('', 'start')).toBeUndefined();
    expect(dateInputToIso('2026-13-45', 'end')).toBeUndefined();
  });

  it('round-trips a local calendar day back into the date input value', () => {
    expect(isoToDateInput(dateInputToIso('2026-10-01', 'start'))).toBe('2026-10-01');
    expect(isoToDateInput(dateInputToIso('2026-10-01', 'end'))).toBe('2026-10-01');
    expect(isoToDateInput(undefined)).toBe('');
    expect(isoToDateInput('not-a-date')).toBe('');
  });
});

describe('AuditFilterBar account filters', () => {
  beforeEach(() => {
    user.current = { isAdmin: true };
  });

  it('offers the user and organization lookups to a full admin', () => {
    render(<AuditFilterBar filters={{ targetKind: 'user' }} onChange={vi.fn()} onClear={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    expect(screen.getByTestId('mock-user-selector-Actor')).toBeInTheDocument();
    expect(screen.getByTestId('mock-user-selector-Target user')).toBeInTheDocument();
  });

  it('gives a delegate id inputs, since the lookups list only full admins results', () => {
    user.current = { isAdmin: false, adminPermissions: ['support:read'] };
    const onChange = vi.fn();
    render(<AuditFilterBar filters={{ targetKind: 'organization' }} onChange={onChange} onClear={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    expect(screen.queryByTestId('mock-user-selector-Actor')).toBeNull();
    const actor = screen.getByTestId('audit-filter-actor-id');
    fireEvent.change(actor, { target: { value: ' 0123456789abcdef01234567 ' } });
    fireEvent.blur(actor);
    expect(onChange).toHaveBeenCalledWith({ actorUserId: '0123456789abcdef01234567' });
    expect(screen.getByTestId('audit-filter-target-id')).toBeInTheDocument();
  });
});
