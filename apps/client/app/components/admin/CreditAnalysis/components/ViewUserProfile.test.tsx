import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ViewUserProfile from './ViewUserProfile';

const openUserProfile = vi.hoisted(() => vi.fn());
vi.mock('@client/app/components/admin/Users/Profile/useOpenUserProfile', () => ({
  useOpenUserProfile: () => openUserProfile,
}));

const appTheme = extendTheme({ ...getThemeConfig() });

describe('ViewUserProfile', () => {
  it('opens the full-page profile of the user', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <ViewUserProfile userId="user-1" size="sm" />
      </CssVarsProvider>
    );

    fireEvent.click(screen.getByTestId('view-user-profile-btn'));

    expect(openUserProfile).toHaveBeenCalledWith('user-1');
  });
});
