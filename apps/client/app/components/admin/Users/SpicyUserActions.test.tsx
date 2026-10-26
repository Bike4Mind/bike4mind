import { ADMIN_PERMISSIONS } from '@bike4mind/common';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import SpicyUserActions from './SpicyUserActions';

const actor = vi.hoisted(() => ({ currentUser: { isAdmin: true, adminPermissions: [] as string[] } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign((selector: (state: typeof actor) => unknown) => selector(actor), { getState: () => actor }),
}));

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

describe('SpicyUserActions - accessible names', () => {
  it('labels the Ban and Moderate checkboxes', () => {
    render(<SpicyUserActions user={user} editedFields={{}} onFieldChange={vi.fn()} handleDeleteUser={vi.fn()} />, {
      wrapper: TestWrapper,
    });

    expect(screen.getByRole('checkbox', { name: 'Ban' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Moderate' })).toBeInTheDocument();
  });
});

describe('privileged target ban controls', () => {
  const renderActions = (target: AdminUserListItem, onFieldChange = vi.fn()) => {
    render(
      <SpicyUserActions user={target} editedFields={{}} onFieldChange={onFieldChange} handleDeleteUser={vi.fn()} />,
      { wrapper: TestWrapper }
    );
    return onFieldChange;
  };
  it.each([{ isAdmin: true }, { isAdmin: false, adminPermissions: ['support:read'] }])(
    'blocks newly banning privileged target %j for a moderator',
    target => {
      actor.currentUser = { isAdmin: false, adminPermissions: ['support:read', 'users:moderate'] };
      renderActions({ ...user, ...target } as AdminUserListItem);
      expect(screen.getByTestId('admin-user-ban-checkbox').querySelector('input')).toBeDisabled();
      expect(screen.getByText(/Full admin access is required to ban/)).toBeInTheDocument();
    }
  );
  it('allows a delegated moderator to clear an existing privileged target ban', () => {
    actor.currentUser = { isAdmin: false, adminPermissions: ['support:read', 'users:moderate'] };
    const changed = renderActions({ ...user, isAdmin: true, isBanned: true });
    const checkbox = screen.getByTestId('admin-user-ban-checkbox').querySelector('input')!;
    expect(checkbox).toBeEnabled();
    fireEvent.click(checkbox);
    expect(changed).toHaveBeenCalledWith('isBanned', false);
  });
  it('allows a delegated moderator to ban an ordinary target', () => {
    actor.currentUser = { isAdmin: false, adminPermissions: ['support:read', 'users:moderate'] };
    const changed = renderActions({ ...user, isAdmin: false, adminPermissions: [] });
    const checkbox = screen.getByTestId('admin-user-ban-checkbox').querySelector('input')!;
    expect(checkbox).toBeEnabled();
    fireEvent.click(checkbox);
    expect(changed).toHaveBeenCalledWith('isBanned', true);
  });
  it('allows a legacy isAdmin=true actor to ban admin targets', () => {
    actor.currentUser = { isAdmin: true, adminPermissions: [] };
    const changed = renderActions({ ...user, isAdmin: true });
    const checkbox = screen.getByTestId('admin-user-ban-checkbox').querySelector('input')!;
    expect(checkbox).toBeEnabled();
    fireEvent.click(checkbox);
    expect(changed).toHaveBeenCalledWith('isBanned', true);
  });
  it('blocks an actor holding every explicit permission but isAdmin=false from banning admin targets', () => {
    actor.currentUser = { isAdmin: false, adminPermissions: [...ADMIN_PERMISSIONS] };
    const changed = renderActions({ ...user, isAdmin: true });
    const checkbox = screen.getByTestId('admin-user-ban-checkbox').querySelector('input')!;
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/Full admin access is required to ban/)).toBeInTheDocument();
    fireEvent.click(checkbox);
    expect(changed).not.toHaveBeenCalled();
  });
});
