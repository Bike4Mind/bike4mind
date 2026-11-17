import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

// Runs the real useStudioFeatureAccess and gate, so who gets the editor, the upgrade prompt or not-found comes from
// the shared rule in @bike4mind/common, with only the viewer, the settings and the entitlements stubbed.
const h = vi.hoisted(() => ({
  isAdmin: false,
  tags: [] as string[],
  audience: 'paid' as string,
  entitlements: [] as string[] | undefined,
  enforceCredits: true,
  enabledSettings: new Set<string>(),
  openView: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { isAdmin: boolean; currentUser: { tags: string[] } }) => unknown) =>
    selector({ isAdmin: h.isAdmin, currentUser: { tags: h.tags } }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: (key: string) => h.enabledSettings.has(key), isLoading: false }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) =>
    key === 'enforceCredits' ? h.enforceCredits : key === 'StudioProductionsAudience' ? h.audience : undefined,
}));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: ({ enabled }: { enabled: boolean }) => ({
    data: enabled ? h.entitlements : undefined,
    isError: false,
  }),
}));
vi.mock('@client/app/components/subscription/BillingDeepLinkModals', () => ({
  useBillingView: () => ({ openView: h.openView }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ authedSettingsLoaded: true, error: null }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (selector: (state: { accessToken: string | null }) => unknown) => selector({ accessToken: 'token' }),
}));
vi.mock('@tanstack/react-router', async () => {
  const { createLinkStub } = await import('@client/app/components/Studio/testUtils/routerLinkMock');
  return { createLink: createLinkStub };
});
vi.mock('@client/app/components/Studio/v2/StudioCreditsBalance', () => ({ default: () => null }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/components/NotFound', () => ({ default: () => <div data-testid="not-found-stub" /> }));
vi.mock('@client/app/components/Studio/productions/ProductionsList', () => ({
  default: () => <div data-testid="productions-list" />,
}));

import StudioProductionsRoute from './productions';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderRoute = () =>
  render(<CssVarsProvider theme={appTheme}>{(<StudioProductionsRoute />) as ReactNode}</CssVarsProvider>);

beforeEach(() => {
  h.isAdmin = false;
  h.tags = [];
  h.audience = 'paid';
  h.entitlements = [];
  h.enforceCredits = true;
  h.openView.mockClear();
  h.enabledSettings = new Set(['EnableStudioCreateV2', 'EnableStudioProductions']);
});

describe('Productions under the paid audience', () => {
  it('shows a free user the upgrade prompt, not the editor, and keeps the Productions tab', () => {
    renderRoute();
    expect(screen.getByTestId('studio-upgrade-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('productions-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('studio-area-productions')).toBeInTheDocument();
  });

  it('opens the billing plans view from the Upgrade button', () => {
    renderRoute();
    fireEvent.click(screen.getByTestId('studio-upgrade-prompt-btn'));
    expect(h.openView).toHaveBeenCalledWith('plans');
  });

  it('omits the Upgrade button when billing is off', () => {
    h.enforceCredits = false;
    renderRoute();
    expect(screen.getByTestId('studio-upgrade-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-upgrade-prompt-btn')).not.toBeInTheDocument();
  });

  it('opens the editor for a paid user', () => {
    h.entitlements = ['plan:paid'];
    renderRoute();
    expect(screen.getByTestId('productions-list')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-upgrade-prompt')).not.toBeInTheDocument();
  });

  it('opens the editor for a developer and an admin', () => {
    h.tags = ['Developer'];
    const { unmount } = renderRoute();
    expect(screen.getByTestId('productions-list')).toBeInTheDocument();
    unmount();
    h.tags = [];
    h.isAdmin = true;
    renderRoute();
    expect(screen.getByTestId('productions-list')).toBeInTheDocument();
  });
});

describe('Productions under the admins audience', () => {
  it('answers not found to a free user and a paid user', () => {
    h.audience = 'admins';
    const { unmount } = renderRoute();
    expect(screen.getByTestId('not-found-stub')).toBeInTheDocument();
    unmount();
    h.entitlements = ['plan:paid'];
    renderRoute();
    expect(screen.getByTestId('not-found-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-upgrade-prompt')).not.toBeInTheDocument();
  });
});
