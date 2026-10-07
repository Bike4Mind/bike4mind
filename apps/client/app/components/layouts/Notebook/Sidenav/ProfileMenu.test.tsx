import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useCookieSettings } from '@client/app/components/CookieConsentBanner';
import ProfileMenu, { AccountCard, closeSideNavOnOverlay } from './ProfileMenu';

// Just enough of the menu's data hooks to render it; none of these rows are under test here.
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@client/app/components/inbox/Badge', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@client/app/components/subscription/CreditsModal', () => ({ default: () => null }));
vi.mock('@client/app/components/subscription/SubscriptionModal', () => ({ default: () => null }));
vi.mock('@client/app/contexts/InboxContext', () => ({
  useInbox: { getState: () => ({ setOpen: vi.fn() }) },
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select: (s: unknown) => unknown) => select({ currentUser: { id: 'u1', name: 'Jane' }, isAdmin: false }),
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => vi.fn() }));
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => false }));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetFriendRequests: () => ({ data: [] }),
  useReturnToAdmin: () => vi.fn(),
  useUserLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (s: unknown) => unknown) => select({ impersonating: false }),
}));
vi.mock('@client/app/hooks/useAppVersion', () => ({ useAppVersion: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => false }));
vi.mock('@client/app/hooks/data/entitlements', () => ({ useEntitlements: () => ({ data: undefined }) }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useAccounts: () => ({ accounts: [], selectedAccount: null, setSelectedAccount: vi.fn(), showAccountType: false }),
}));
vi.mock('..', () => ({
  useNotebookLayout: (select: (s: unknown) => unknown) => select({ setOpenSideNav: vi.fn() }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ProfileMenu AccountCard - enforceCredits gating', () => {
  it('shows the credit balance chip when showCredits is true', () => {
    render(
      <TestWrapper>
        <AccountCard name="Jane" typeLabel={null} credits={1234} selected onSelect={vi.fn()} showCredits />
      </TestWrapper>
    );

    expect(screen.getByText('1,234')).toBeInTheDocument();
  });

  it('hides the credit balance chip when showCredits is false (enforceCredits off)', () => {
    render(
      <TestWrapper>
        <AccountCard name="Jane" typeLabel={null} credits={1234} selected onSelect={vi.fn()} showCredits={false} />
      </TestWrapper>
    );

    expect(screen.queryByText('1,234')).not.toBeInTheDocument();
    // The rest of the card still renders - only the balance disappears.
    expect(screen.getByText('Jane')).toBeInTheDocument();
  });
});

describe('closeSideNavOnOverlay', () => {
  it('closes the overlay sidenav on phone and tablet navigation', () => {
    const setOpenSideNav = vi.fn();

    closeSideNavOnOverlay(true, setOpenSideNav);

    expect(setOpenSideNav).toHaveBeenCalledWith(false);
  });

  it('leaves the desktop sidenav state unchanged', () => {
    const setOpenSideNav = vi.fn();

    closeSideNavOnOverlay(false, setOpenSideNav);

    expect(setOpenSideNav).not.toHaveBeenCalled();
  });
});

describe('ProfileMenu - Cookie settings', () => {
  const TRACKER_ENV = ['NEXT_PUBLIC_GA_MEASUREMENT_ID', 'NEXT_PUBLIC_REDDIT_PIXEL_ID', 'NEXT_PUBLIC_META_PIXEL_ID'];

  beforeEach(() => {
    for (const name of TRACKER_ENV) vi.stubEnv(name, '');
    useCookieSettings.setState({ isOpen: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const openMoreFlyout = () => {
    render(
      <TestWrapper>
        <ProfileMenu />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('profile-menu-card'));
    fireEvent.click(screen.getByTestId('profile-menu-more'));
  };

  it('reopens the consent banner from the More flyout and closes the menu', () => {
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', 'test-id');
    openMoreFlyout();

    fireEvent.click(screen.getByTestId('profile-more-cookie-settings'));

    expect(useCookieSettings.getState().isOpen).toBe(true);
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
  });

  it('opens settings for attribution consent when no tracker is configured', () => {
    openMoreFlyout();

    expect(screen.getByTestId('profile-more-terms')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('profile-more-cookie-settings'));
    expect(useCookieSettings.getState().isOpen).toBe(true);
  });
});

describe('ProfileMenu - API Docs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the same-origin API docs in a new tab and closes the menu', () => {
    // openExternalLinkByKey opens via a transient anchor click.
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    render(
      <TestWrapper>
        <ProfileMenu />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('profile-menu-card'));
    fireEvent.click(screen.getByTestId('profile-menu-more'));

    fireEvent.click(screen.getByTestId('profile-more-api-docs'));

    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute('href')).toBe('/api/v1/docs');
    expect(clicked[0].target).toBe('_blank');
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
  });
});
