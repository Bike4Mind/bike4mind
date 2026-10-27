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
