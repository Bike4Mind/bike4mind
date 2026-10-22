import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';
import { SidebarNav } from './AdminSidebarNav';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

describe('SidebarNav', () => {
  it('selects the Dashboard tab from the Dashboard button', () => {
    const onTabSelect = vi.fn();
    render(<SidebarNav showLiveOpsTriageTab={false} hiddenNotifications={[]} onTabSelect={onTabSelect} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByTestId('admin-dashboard-tab-btn'));

    expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.Dashboard);
  });
});
