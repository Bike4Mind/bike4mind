import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import SpicyUserActions from './SpicyUserActions';

vi.mock('@client/app/components/help/DestructiveActionHelp', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const user = {
  id: 'u1',
  name: 'Ada',
  email: 'ada@example.com',
  isBanned: false,
  isModerated: false,
} as AdminUserListItem;

const openConfirmModal = (handleDeleteUser: (id: string, reason: string) => Promise<void>) => {
  render(
    <SpicyUserActions user={user} editedFields={{}} onFieldChange={vi.fn()} handleDeleteUser={handleDeleteUser} />,
    {
      wrapper: TestWrapper,
    }
  );
  fireEvent.click(screen.getByTestId('delete-user-btn'));
};

describe('SpicyUserActions - delete reason', () => {
  it('keeps Delete disabled until a valid reason and the typed email, then passes the trimmed reason', async () => {
    const handleDeleteUser = vi.fn().mockResolvedValue(undefined);
    openConfirmModal(handleDeleteUser);

    const confirmButton = screen.getByTestId('confirm-delete-btn');
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('user-delete-reason-input'), { target: { value: 'abc' } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('user-delete-reason-input'), { target: { value: '  Account abuse report  ' } });
    expect(confirmButton).toBeDisabled();
    expect(screen.getByTestId('delete-user-dialog-hint')).toHaveTextContent('Type the email address exactly');

    fireEvent.change(screen.getByTestId('delete-user-confirm-input'), { target: { value: 'ada@example.com' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(handleDeleteUser).toHaveBeenCalledWith('u1', 'Account abuse report'));
  });
});

describe('SpicyUserActions - accessible names', () => {
  it('labels the Ban and Moderate checkboxes', () => {
    render(<SpicyUserActions user={user} editedFields={{}} onFieldChange={vi.fn()} handleDeleteUser={vi.fn()} />, {
      wrapper: TestWrapper,
    });

    expect(screen.getByRole('checkbox', { name: 'Ban' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Moderate' })).toBeInTheDocument();
  });
});

describe('SpicyUserActions - restricted tier', () => {
  const renderWith = (overrides: Record<string, unknown>, onFieldChange = vi.fn(), staged = false) => {
    render(
      <SpicyUserActions
        user={{ ...user, ...overrides } as AdminUserListItem}
        editedFields={staged ? { throttleTier: true } : {}}
        onFieldChange={onFieldChange}
        handleDeleteUser={vi.fn()}
      />,
      { wrapper: TestWrapper }
    );
    return onFieldChange;
  };

  it('reflects the stored tier and lists source, date and signals read-only', () => {
    renderWith({
      throttle: { tier: 'shadow', reason: 'r', source: 'signup_honeypot', changedAt: '2026-01-02T03:04:05.000Z' },
      riskSignals: [{ type: 'signup_honeypot', at: '2026-01-02T03:04:05.000Z' }],
    });

    expect(screen.getByRole('checkbox', { name: 'Shadow tier' })).toBeChecked();
    expect(screen.getByTestId('admin-user-shadow-info')).toHaveTextContent('signup_honeypot');
    expect(screen.getByTestId('admin-user-shadow-info')).toHaveTextContent('2026-01-02');
  });

  it('renders no stray text for an empty signal list', () => {
    renderWith({ riskSignals: [] });

    expect(screen.queryByTestId('admin-user-shadow-info')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('stages the tier when toggled and the reason when typed', () => {
    const onFieldChange = renderWith({}, vi.fn(), true);

    expect(screen.getByRole('checkbox', { name: 'Shadow tier' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shadow tier' }));
    expect(onFieldChange).toHaveBeenCalledWith('throttleTier', 'shadow');

    fireEvent.change(screen.getByTestId('admin-user-shadow-reason-input').querySelector('input') as HTMLInputElement, {
      target: { value: 'bulk signups' },
    });
    expect(onFieldChange).toHaveBeenCalledWith('throttleReason', 'bulk signups');
  });

  it('clearing a shadowed user stages none', () => {
    const onFieldChange = renderWith({ throttle: { tier: 'shadow', source: 'admin', changedAt: '2026-01-02' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shadow tier' }));
    expect(onFieldChange).toHaveBeenCalledWith('throttleTier', 'none');
  });
});
