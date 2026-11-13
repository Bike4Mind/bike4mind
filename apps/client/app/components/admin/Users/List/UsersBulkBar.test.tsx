import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { USERS_BULK_ACTIONS, USERS_BULK_ACTION_COPY } from './UsersBulkActionDialog';
import { UsersBulkBar } from './UsersBulkBar';

const user = vi.hoisted(() => ({ current: { id: 'u1', isAdmin: true } as Record<string, unknown> }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const renderBar = () =>
  render(
    <UsersBulkBar
      selection={{ mode: 'explicit', ids: ['a'.repeat(24)] }}
      totalMatching={10}
      onSelectAllMatching={vi.fn()}
      onClear={vi.fn()}
      onAction={vi.fn()}
    />,
    { wrapper: Wrapper }
  );

describe('UsersBulkBar help', () => {
  it('explains every bulk action from a help button', async () => {
    renderBar();
    expect(screen.queryByTestId('admin-users-bulk-legend')).toBeNull();

    const help = screen.getByTestId('admin-users-bulk-help-btn');
    expect(help).toHaveAccessibleName('About bulk actions');
    fireEvent.click(help);

    const legend = await screen.findByTestId('admin-users-bulk-legend');
    for (const type of USERS_BULK_ACTIONS) {
      const entry = within(legend).getByTestId(`admin-users-bulk-legend-${type}`);
      expect(entry).toHaveTextContent(USERS_BULK_ACTION_COPY[type].label);
      expect(entry).toHaveTextContent(USERS_BULK_ACTION_COPY[type].description);
    }
    expect(legend).toHaveTextContent('undo it for 30 seconds');
  });
});

describe('UsersBulkBar permissions', () => {
  it('enables every action for a full admin', () => {
    user.current = { id: 'u1', isAdmin: true };
    renderBar();
    for (const type of USERS_BULK_ACTIONS) {
      expect(screen.getByTestId(`admin-users-bulk-${type}-btn`)).toBeEnabled();
    }
  });

  it('lets a users:moderate delegate suspend and restrict but not adjust credits, contain or revoke keys', () => {
    user.current = { id: 'u2', isAdmin: false, adminPermissions: ['users:moderate'] };
    renderBar();
    const enabled = (type: string) =>
      !(screen.getByTestId(`admin-users-bulk-${type}-btn`) as HTMLButtonElement).disabled;
    expect(enabled('suspend')).toBe(true);
    expect(enabled('restrict')).toBe(true);
    expect(enabled('adjustCredits')).toBe(false);
    expect(enabled('contain')).toBe(false);
    expect(enabled('revokeApiKeys')).toBe(false);
    expect(enabled('addTag')).toBe(false);
  });

  it('disables the same actions in the narrow-screen menu', () => {
    user.current = { id: 'u2', isAdmin: false, adminPermissions: ['users:moderate'] };
    renderBar();
    fireEvent.click(screen.getByTestId('admin-users-bulk-menu-btn'));
    expect(screen.getByTestId('admin-users-bulk-suspend-menuitem')).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('admin-users-bulk-adjustCredits-menuitem')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('admin-users-bulk-contain-menuitem')).toHaveAttribute('aria-disabled', 'true');
  });
});
