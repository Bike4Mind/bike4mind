import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { AdminTab } from './adminSidebarConfig';
import { canOpenAdminTab } from './adminTabPermissions';
import { canRenderAdminTab } from './adminTabRenderability';
import { adminTabToSlug } from './adminTabSlugs';

const owners = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const summaries = vi.hoisted(() => ({ byBase: {} as Record<string, Record<string, unknown>> }));
const refetch = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/tutorials/useTutorialOwners', () => ({
  useTutorialOwners: () => owners.value,
  useTutorialOwnerSummary: (base: string) => summaries.byBase[base],
}));
vi.mock('@client/app/components/tutorial/admin/TutorialsSwitchCard', () => ({
  default: ({ apiBase }: { apiBase: string }) => <div data-testid="mock-switch-card">{apiBase}</div>,
}));
vi.mock('@client/app/components/tutorial/admin/TutorialModulesCard', () => ({
  default: ({ apiBase, owner }: { apiBase: string; owner: string }) => (
    <div data-testid="mock-modules-card">
      {apiBase} {owner}
    </div>
  ),
}));
vi.mock('@client/app/components/tutorial/admin/TutorialDraftsCard', () => ({
  default: ({ apiBase, owner }: { apiBase: string; owner: string }) => (
    <div data-testid="mock-drafts-card">
      {apiBase} {owner}
    </div>
  ),
}));

import { TutorialsTab } from './TutorialsTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TutorialsTab />
    </CssVarsProvider>
  );

const OWNER_A = { owner: 'alpha', label: 'Alpha', adminBase: '/api/alpha/tutorial', adminHref: '/alpha?mode=admin' };
const OWNER_B = { owner: 'beta', label: 'Beta', adminBase: '/api/beta/tutorial', adminHref: '/beta/admin' };
const loaded = (data: unknown) => ({ data, isLoading: false, isError: false, isFetching: false, refetch });

describe('TutorialsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    owners.value = loaded([]);
    summaries.byBase = {};
  });

  it('renders the Core section with the cards against the core base', () => {
    renderTab();
    expect(screen.getByTestId('tutorials-core-section')).toBeInTheDocument();
    expect(screen.getByTestId('mock-switch-card')).toHaveTextContent('/api/tutorials');
    expect(screen.getByTestId('mock-modules-card')).toHaveTextContent('/api/tutorials core');
    expect(screen.getByTestId('mock-drafts-card')).toHaveTextContent('/api/tutorials core');
    expect(screen.queryByTestId('tutorials-owner-alpha')).not.toBeInTheDocument();
  });

  it('renders one section per contributed owner, with its tutorials and an edit link', () => {
    owners.value = loaded([OWNER_A]);
    summaries.byBase[OWNER_A.adminBase] = loaded([
      { id: 'one', title: 'First walk', enabled: true },
      { id: 'two', title: 'Second walk', enabled: false },
    ]);
    renderTab();
    expect(screen.getByTestId('tutorials-owner-alpha')).toHaveTextContent('Alpha');
    expect(screen.getByTestId('tutorials-owner-row-alpha-one')).toHaveTextContent('First walk');
    expect(screen.getByTestId('tutorials-owner-row-alpha-one')).toHaveTextContent('on');
    expect(screen.getByTestId('tutorials-owner-row-alpha-two')).toHaveTextContent('off');
    const link = screen.getByTestId('tutorials-owner-link-alpha');
    expect(link).toHaveTextContent('Edit in Alpha');
    expect(link).toHaveAttribute('href', '/alpha?mode=admin');
  });

  it('shows Could not load with a retry for a failing owner and still renders the rest', () => {
    owners.value = loaded([OWNER_A, OWNER_B]);
    summaries.byBase[OWNER_A.adminBase] = {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch,
    };
    summaries.byBase[OWNER_B.adminBase] = loaded([{ id: 'x', title: 'Fine walk', enabled: true }]);
    renderTab();
    expect(screen.getByTestId('tutorials-owner-error-alpha')).toHaveTextContent('Could not load');
    expect(screen.getByTestId('tutorials-owner-row-beta-x')).toHaveTextContent('Fine walk');
    expect(screen.getByTestId('tutorials-core-section')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tutorials-owner-retry-alpha'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the Core section when the owners list itself fails', () => {
    owners.value = { data: undefined, isLoading: false, isError: true, isFetching: false, refetch };
    renderTab();
    expect(screen.getByTestId('tutorials-core-section')).toBeInTheDocument();
    expect(screen.getByTestId('tutorials-owners-error')).toHaveTextContent('Could not load');
    fireEvent.click(screen.getByTestId('tutorials-owners-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('Tutorials tab access', () => {
  const user = (isAdmin: boolean, ...adminPermissions: string[]) => ({ isAdmin, adminPermissions });

  it('opens for a full admin only', () => {
    expect(canOpenAdminTab(user(true), AdminTab.Tutorials)).toBe(true);
    expect(canRenderAdminTab(AdminTab.Tutorials, { user: user(true) })).toBe(true);
  });

  it('stays closed to a delegated admin, whatever permissions they hold', () => {
    const everything = user(false, 'support:read', 'settings:manage', 'users:moderate', 'credits:adjust');
    expect(canOpenAdminTab(everything, AdminTab.Tutorials)).toBe(false);
    expect(canRenderAdminTab(AdminTab.Tutorials, { user: everything })).toBe(false);
  });

  it('has a URL slug', () => {
    expect(adminTabToSlug(AdminTab.Tutorials)).toBe('tutorials');
  });
});
