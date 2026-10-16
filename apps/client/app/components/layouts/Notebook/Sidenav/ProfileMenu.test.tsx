import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useCookieSettings } from '@client/app/components/CookieConsentBanner';
import ProfileMenu, { AccountCard, closeSideNavOnOverlay } from './ProfileMenu';

// Just enough of the menu's data hooks to render it; none of these rows are under test here.
const router = vi.hoisted(() => ({ pathname: '/new', navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => router.navigate,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: router.pathname }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@client/app/components/inbox/Badge', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
const billing = vi.hoisted(() => ({ openView: vi.fn(), creditsEnabled: false }));
vi.mock('@client/app/components/subscription/BillingDeepLinkModals', () => ({
  useBillingView: () => ({ view: undefined, openView: billing.openView, closeView: vi.fn() }),
}));
vi.mock('@client/app/contexts/InboxContext', () => ({
  useInbox: { getState: () => ({ setOpen: vi.fn() }) },
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select: (s: unknown) => unknown) => select({ currentUser: { id: 'u1', name: 'Jane' }, isAdmin: false }),
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => billing.creditsEnabled }));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetFriendRequests: () => ({ data: [] }),
  useReturnToAdmin: () => vi.fn(),
  useUserLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (s: unknown) => unknown) => select({ impersonating: false }),
}));
vi.mock('@client/app/hooks/useAppVersion', () => ({ useAppVersion: () => ({ data: undefined }) }));
const features = vi.hoisted(() => ({ enabled: new Set<string>() }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: (key: string) => features.enabled.has(key) }),
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

describe('ProfileMenu AccountCard - semantics', () => {
  const renderCard = (props: Partial<React.ComponentProps<typeof AccountCard>> = {}) =>
    render(
      <TestWrapper>
        <AccountCard name="Jane" typeLabel="(Team)" credits={1234} selected onSelect={vi.fn()} showCredits {...props} />
      </TestWrapper>
    );

  it('is a menuitemradio that reflects its selected state', () => {
    const view = renderCard({ selected: true });
    expect(screen.getByTestId('profile-account-option').getAttribute('role')).toBe('menuitemradio');
    expect(screen.getByRole('menuitemradio').getAttribute('aria-checked')).toBe('true');
    view.unmount();
    renderCard({ selected: false });
    expect(screen.getByRole('menuitemradio').getAttribute('aria-checked')).toBe('false');
  });

  it('is named by its content, so the account type is announced with the name', () => {
    renderCard();
    expect(screen.getByRole('menuitemradio', { name: /Jane.*\(Team\)/ })).toBeInTheDocument();
  });

  it('hides the radio decoration from the accessibility tree', () => {
    renderCard({ bare: false });
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);
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

describe('ProfileMenu - billing rows open URL-addressable views', () => {
  beforeEach(() => {
    billing.openView.mockClear();
    billing.creditsEnabled = true;
  });

  afterEach(() => {
    billing.creditsEnabled = false;
  });

  const openMenu = () => {
    render(
      <TestWrapper>
        <ProfileMenu />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('profile-menu-card'));
  };

  it('shows one Billing row and no separate Credits or Subscriptions rows', () => {
    openMenu();
    expect(screen.getByTestId('profile-menu-billing')).toHaveTextContent('Billing');
    expect(screen.queryByTestId('profile-menu-credits')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-menu-subscriptions')).not.toBeInTheDocument();
  });

  it('hides the Billing row when enforceCredits is off', () => {
    billing.creditsEnabled = false;
    openMenu();
    expect(screen.queryByTestId('profile-menu-billing')).not.toBeInTheDocument();
  });

  it('has no Inbox or Your feedback rows, and Invite sits directly under Teams', () => {
    openMenu();
    fireEvent.click(screen.getByTestId('profile-menu-more'));
    expect(screen.queryByTestId('profile-more-inbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-more-invite')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-menu-feedback-rollup')).not.toBeInTheDocument();
    const teams = screen.getByTestId('profile-menu-teams');
    const invite = screen.getByTestId('profile-menu-invite');
    expect(invite).toHaveTextContent('Invite a friend');
    expect(teams.nextElementSibling).toBe(invite);
  });

  it('opens the credits view through the URL', () => {
    openMenu();
    fireEvent.click(screen.getByTestId('profile-menu-billing'));
    expect(billing.openView).toHaveBeenCalledWith('credits');
  });
});

describe('ProfileMenu - keyboard', () => {
  beforeEach(() => {
    billing.openView.mockClear();
    billing.creditsEnabled = true;
  });

  afterEach(() => {
    billing.creditsEnabled = false;
  });

  const renderMenu = () =>
    render(
      <TestWrapper>
        <ProfileMenu />
      </TestWrapper>
    );

  const openByKeyboard = (key = 'Enter') => {
    renderMenu();
    const trigger = screen.getByTestId('profile-menu-card');
    trigger.focus();
    fireEvent.keyDown(trigger, { key });
    return trigger;
  };

  const panelItems = () =>
    Array.from(screen.getByTestId('profile-menu-panel').querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
      el => el.closest('[role="menu"]') === screen.getByTestId('profile-menu-panel')
    );

  it('moves focus to the first item when it opens', () => {
    openByKeyboard();
    expect(document.activeElement).toBe(screen.getByTestId('profile-menu-profile'));
  });

  it('opens on ArrowUp with focus on the last item', () => {
    openByKeyboard('ArrowUp');
    expect(document.activeElement).toBe(screen.getByTestId('logout-btn'));
  });

  it('walks the items with the arrow keys and wraps', () => {
    openByKeyboard();
    const items = panelItems();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('keeps every item out of the Tab order', () => {
    openByKeyboard();
    for (const item of panelItems()) expect(item.tabIndex).toBe(-1);
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const trigger = openByKeyboard();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Tab instead of walking the page behind it', () => {
    const trigger = openByKeyboard();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens More with ArrowRight and closes it with Escape back onto More', () => {
    openByKeyboard();
    const more = screen.getByTestId('profile-menu-more');
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowRight' });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('profile-more-about'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByTestId('profile-menu-more-flyout')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-menu-panel')).toBeInTheDocument();
    expect(document.activeElement).toBe(more);
  });

  it('hands focus to the trigger before opening a dialog, so the dialog can restore it', () => {
    const trigger = openByKeyboard();
    let focusedWhenOpened: Element | null = null;
    billing.openView.mockImplementationOnce(() => {
      focusedWhenOpened = document.activeElement;
    });
    fireEvent.click(screen.getByTestId('profile-menu-billing'));
    expect(focusedWhenOpened).toBe(trigger);
  });
});

describe('ProfileMenu - focus after navigating', () => {
  beforeEach(() => {
    router.navigate.mockClear();
  });

  const openMenu = () => {
    render(
      <TestWrapper>
        <ProfileMenu />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('profile-menu-card'));
  };

  it('keeps focus on the account card when the target is the page already open (Connections on /integrations)', () => {
    router.pathname = '/integrations';
    openMenu();
    fireEvent.click(screen.getByTestId('profile-menu-connections'));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/integrations', search: { source: 'profile_menu' } });
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('profile-menu-card'));
  });

  it('keeps focus on the account card for Profile when already on /profile', () => {
    router.pathname = '/profile';
    openMenu();
    fireEvent.click(screen.getByTestId('profile-menu-profile'));
    expect(document.activeElement).toBe(screen.getByTestId('profile-menu-card'));
  });

  it('leaves focus for the layout to move to the new heading when the pathname changes', () => {
    router.pathname = '/new';
    openMenu();
    fireEvent.click(screen.getByTestId('profile-menu-profile'));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/profile' });
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it('opens the Connections page, attributed to this menu, and closes the menu', () => {
    router.pathname = '/new';
    openMenu();
    fireEvent.click(screen.getByTestId('profile-menu-connections'));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/integrations', search: { source: 'profile_menu' } });
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
  });
});

describe('ProfileMenu - Connections', () => {
  beforeEach(() => {
    router.pathname = '/new';
    router.navigate.mockClear();
  });

  const openMenu = () => {
    render(
      <TestWrapper>
        <ProfileMenu />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('profile-menu-card'));
  };

  it('shows one Connections row in place of the separate Integrations and API Keys rows', () => {
    openMenu();
    expect(screen.getByTestId('profile-menu-connections')).toHaveTextContent('Connections');
    expect(screen.queryByTestId('profile-menu-integrations')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-menu-api-keys')).not.toBeInTheDocument();
  });

  it('explains the Connections row in a tooltip on hover', async () => {
    openMenu();
    fireEvent.mouseOver(screen.getByTestId('profile-menu-connections'));
    expect(
      await screen.findByText('Integrations like Google Drive and Slack, plus API keys for your own code')
    ).toBeInTheDocument();
  });

  it('lists API Keys directly above API Docs in More and opens the API Keys tab', () => {
    openMenu();
    fireEvent.click(screen.getByTestId('profile-menu-more'));
    const keys = screen.getByTestId('profile-more-api-keys');
    expect(keys.nextElementSibling).toBe(screen.getByTestId('profile-more-api-docs'));

    fireEvent.click(keys);
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/integrations',
      search: { tab: 'api-keys', source: 'profile_menu' },
    });
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
  });
});

describe('ProfileMenu - roles and keyboard details', () => {
  const renderMenu = () =>
    render(
      <TestWrapper>
        <ProfileMenu />
      </TestWrapper>
    );

  const openByKeyboard = () => {
    renderMenu();
    const trigger = screen.getByTestId('profile-menu-card');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    return trigger;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the theme toggles as a checked/unchecked menuitemradio pair', () => {
    openByKeyboard();
    const dark = screen.getByRole('menuitemradio', { name: 'Dark mode' });
    const light = screen.getByRole('menuitemradio', { name: 'Light mode' });
    expect([dark.getAttribute('aria-checked'), light.getAttribute('aria-checked')].sort()).toEqual(['false', 'true']);
  });

  it('closes on Shift+Tab and returns focus to the trigger', () => {
    const trigger = openByKeyboard();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(screen.queryByTestId('profile-menu-panel')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('moves to the first item on Home', () => {
    openByKeyboard();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('logout-btn'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByTestId('profile-menu-profile'));
  });

  it('closes the More flyout on ArrowLeft and puts focus back on More', () => {
    openByKeyboard();
    const more = screen.getByTestId('profile-menu-more');
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(screen.queryByTestId('profile-menu-more-flyout')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-menu-panel')).toBeInTheDocument();
    expect(document.activeElement).toBe(more);
  });

  it('moves into an already-open More flyout on ArrowRight', () => {
    openByKeyboard();
    const more = screen.getByTestId('profile-menu-more');
    fireEvent.click(more);
    more.focus();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(more, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('profile-more-about'));
  });

  it('hands focus to the trigger before a non-billing row opens a new tab', () => {
    const trigger = openByKeyboard();
    let focusedWhenOpened: Element | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      focusedWhenOpened = document.activeElement;
    });
    fireEvent.click(screen.getByTestId('profile-menu-more'));
    fireEvent.click(screen.getByTestId('profile-more-changelog'));
    expect(focusedWhenOpened).toBe(trigger);
  });
});

describe('ProfileMenu - Hearth', () => {
  afterEach(() => {
    features.enabled.clear();
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

  it('opens Hearth from the More flyout when its flag is on', () => {
    features.enabled.add('enableHearth');
    router.pathname = '/new';
    openMoreFlyout();
    fireEvent.click(screen.getByTestId('profile-more-hearth'));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/hearth' });
  });

  it('hides Hearth when its flag is off', () => {
    openMoreFlyout();
    expect(screen.queryByTestId('profile-more-hearth')).not.toBeInTheDocument();
  });
});
