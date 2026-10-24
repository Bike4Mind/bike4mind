import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

const user = { id: 'u1', name: 'Ada', isBanned: false, isModerated: false } as AdminUserListItem;

const openConfirmModal = (handleDeleteUser: (id: string, reason: string) => Promise<void>) => {
  render(
    <SpicyUserActions user={user} editedFields={{}} onFieldChange={vi.fn()} handleDeleteUser={handleDeleteUser} />,
    {
      wrapper: TestWrapper,
    }
  );
  fireEvent.change(screen.getByTestId('delete-user-confirm-input').querySelector('input') as HTMLInputElement, {
    target: { value: 'DELETE' },
  });
  fireEvent.click(screen.getByTestId('delete-user-btn'));
};

describe('SpicyUserActions - delete reason', () => {
  it('keeps Delete disabled until a valid reason is entered, then passes the trimmed reason', () => {
    const handleDeleteUser = vi.fn().mockResolvedValue(undefined);
    openConfirmModal(handleDeleteUser);

    const confirmButton = screen.getByTestId('confirm-delete-btn');
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('user-delete-reason-input'), { target: { value: 'abc' } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('user-delete-reason-input'), { target: { value: '  Account abuse report  ' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    expect(handleDeleteUser).toHaveBeenCalledWith('u1', 'Account abuse report');
  });
});
