import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminProfile from './AdminProfile';

const openUserProfile = vi.hoisted(() => vi.fn());
vi.mock('@client/app/components/admin/Users/Profile/useOpenUserProfile', () => ({
  useOpenUserProfile: () => openUserProfile,
}));

const appTheme = extendTheme({ ...getThemeConfig() });

describe('AdminProfile', () => {
  it('opens the full-page profile of the user', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <AdminProfile userId="user-1" />
      </CssVarsProvider>
    );

    fireEvent.click(screen.getByTestId('admin-user-profile-btn'));

    expect(openUserProfile).toHaveBeenCalledWith('user-1');
  });
});
