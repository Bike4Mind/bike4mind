import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Mocks
const mockNavigate = vi.fn();
let searchValue: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => searchValue,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1', name: 'Test User' }, isAdmin: false }),
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: undefined }),
}));

vi.mock('@client/app/hooks/data/user', () => ({
  useGetFriendRequests: () => ({ data: [] }),
}));

vi.mock('@client/app/hooks/useDocumentTitle', () => ({
  useDocumentTitle: () => undefined,
}));

vi.mock('@client/app/components/help', () => ({
  ContextHelpButton: () => null,
}));

// next/dynamic + static tab content are irrelevant to the strip itself; stub them
// so the test stays focused on which tabs render and the redirect behavior.
vi.mock('next/dynamic', () => ({
  default: () => () => null,
}));
vi.mock('@client/app/components/ProfileModal/ProfileDetailTabContent', () => ({
  default: () => <div data-testid="profile-detail-stub" />,
}));
vi.mock('@client/app/components/ProfileModal/CommunityTabContent', () => ({
  default: () => <div data-testid="community-stub" />,
}));

import ProfilePage from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderPage = () =>
  render(
    <Wrapper>
      <ProfilePage />
    </Wrapper>
  );

describe('ProfilePage tab strip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchValue = {};
  });

  it('renders exactly the six consolidated top-level tabs', () => {
    renderPage();

    expect(screen.getByTestId('profile-tab')).toBeInTheDocument();
    expect(screen.getByTestId('community-tab')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab')).toBeInTheDocument();
    // Credit Usage promoted to its own top-level tab.
    expect(screen.getByTestId('usage-tab')).toBeInTheDocument();
    expect(screen.getByTestId('integrations-tab')).toBeInTheDocument();
    expect(screen.getByTestId('security-tab')).toBeInTheDocument();
  });

  it('no longer renders the tabs that moved into /admin or Settings', () => {
    renderPage();

    // Admin moved to /admin; System Prompts / Credit Analytics / Email Inbox /
    // Mementos became Settings sub-tabs; none should appear in the top strip.
    const strip = screen.getByTestId('profile-tablist');
    expect(strip).not.toHaveTextContent('admin.title');
    expect(strip).not.toHaveTextContent('credits.analytics');
    expect(strip).not.toHaveTextContent('Email Inbox');
    expect(strip).not.toHaveTextContent('mementos.title');
  });

  it('redirects the legacy ?tab=admin-settings deep link to /admin', () => {
    searchValue = { tab: 'admin-settings' };
    renderPage();

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/admin', replace: true });
  });

  it('redirects legacy Settings deep links to the matching sub-tab', () => {
    const cases: Array<[string, string]> = [
      ['system-prompts', 'custom-instructions'],
      ['email-inbox', 'email-inbox'],
      ['mementos', 'mementos'],
    ];

    for (const [legacy, subtab] of cases) {
      vi.clearAllMocks();
      searchValue = { tab: legacy };
      const { unmount } = renderPage();
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/profile',
        search: { tab: 'settings', subtab },
        replace: true,
      });
      unmount();
    }
  });

  // Credit Usage moved out of Settings->Billing into its own top-level `usage`
  // tab. Both the legacy top-level alias and the old Settings sub-tab deep link redirect
  // to it so bookmarks keep working.
  it('redirects legacy Credit Usage deep links to the usage tab', () => {
    const cases: Array<Record<string, string>> = [{ tab: 'credit-analysis' }, { tab: 'settings', subtab: 'billing' }];

    for (const search of cases) {
      vi.clearAllMocks();
      searchValue = search;
      const { unmount } = renderPage();
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/profile',
        search: { tab: 'usage' },
        replace: true,
      });
      unmount();
    }
  });

  it('does not redirect for a current, valid tab', () => {
    searchValue = { tab: 'settings' };
    renderPage();

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
