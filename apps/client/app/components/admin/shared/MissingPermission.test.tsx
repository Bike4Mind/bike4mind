import { render, screen } from '@testing-library/react';
import { Button } from '@mui/joy';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminPermissionAction, AdminPermissionGate, MissingPermissionState } from './MissingPermission';

const user = vi.hoisted(() => ({ current: null as null | { isAdmin?: boolean; adminPermissions?: string[] } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));

const theme = extendTheme({ ...getThemeConfig() });
const wrap = (node: React.ReactNode) => render(<CssVarsProvider theme={theme}>{node}</CssVarsProvider>);

beforeEach(() => {
  user.current = { isAdmin: false, adminPermissions: ['support:read'] };
});

describe('MissingPermissionState', () => {
  it('names the missing permission', () => {
    wrap(<MissingPermissionState requirement={['support:read', 'settings:manage']} />);
    expect(screen.getByTestId('admin-missing-permission-state')).toHaveTextContent(
      'Missing permission: support:read or settings:manage'
    );
  });
});

describe('AdminPermissionGate', () => {
  it('renders the content for a user holding the permission', () => {
    wrap(<AdminPermissionGate requirement="support:read">secret</AdminPermissionGate>);
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('renders the missing-permission state instead of the content', () => {
    wrap(<AdminPermissionGate requirement="settings:manage">secret</AdminPermissionGate>);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-missing-permission-state')).toHaveTextContent('settings:manage');
  });

  it('lets a full admin through', () => {
    user.current = { isAdmin: true };
    wrap(<AdminPermissionGate requirement="users:delete">secret</AdminPermissionGate>);
    expect(screen.getByText('secret')).toBeInTheDocument();
  });
});

describe('AdminPermissionAction', () => {
  const action = (requirement: 'support:read' | 'settings:manage') =>
    wrap(
      <AdminPermissionAction requirement={requirement}>
        {disabled => (
          <Button disabled={disabled} data-testid="save-btn">
            Save
          </Button>
        )}
      </AdminPermissionAction>
    );

  it('leaves the action enabled and unwrapped for a permitted user', () => {
    action('support:read');
    expect(screen.getByTestId('save-btn')).toBeEnabled();
    expect(screen.queryByTestId('admin-missing-permission-action')).not.toBeInTheDocument();
  });

  it('names every unmet requirement of an all-of action', () => {
    wrap(
      <AdminPermissionAction requirement={{ allOf: ['support:read', 'credits:adjust', 'users:moderate'] }}>
        {disabled => <Button disabled={disabled}>Undo</Button>}
      </AdminPermissionAction>
    );
    expect(screen.getByTestId('admin-missing-permission-action')).toHaveAttribute(
      'aria-label',
      'Missing permission: credits:adjust; Missing permission: users:moderate'
    );
  });

  it('disables a permitted action when the target is blocked', () => {
    wrap(
      <AdminPermissionAction requirement="support:read" blockedReason="Full admin required for this target">
        {disabled => <Button disabled={disabled}>Moderate</Button>}
      </AdminPermissionAction>
    );
    expect(screen.getByText('Moderate')).toBeDisabled();
    expect(screen.getByTestId('admin-missing-permission-action')).toHaveAttribute(
      'aria-label',
      'Full admin required for this target'
    );
  });

  it('disables the action and explains why', () => {
    action('settings:manage');
    expect(screen.getByTestId('save-btn')).toBeDisabled();
    expect(screen.getByTestId('admin-missing-permission-action')).toBeInTheDocument();
  });
});
