import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AuditFilterBar } from './AuditFilterBar';

vi.mock('@client/app/hooks/data/adminAuditLog', () => ({ downloadAuditLogCsv: vi.fn() }));
vi.mock('@client/app/contexts/SnackbarContext', () => ({ useSnackbar: () => ({ showSnackbar: vi.fn() }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({ data: { data: [] }, isLoading: false }),
}));
vi.mock('@client/app/components/admin/Users/Details/UserSelector', () => ({
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
