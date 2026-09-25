// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, Permission } from '@bike4mind/common';
import en from '@client/app/locales/en.json';
import { OrganizationTabs } from '../orgTabAccess';
import OrganizationPage from '../$id';

/**
 * Both halves of the ?tab= round trip.
 *
 * Reading it: a deep link is resolved against access rules derived from the org document, and that
 * document arrives one render AFTER mount. These pin the deep link surviving that window: a gate
 * evaluated against not-yet-loaded data reads "no access" for everyone, so a reset applied on that
 * first pass discards the caller's intent before the answer is knowable.
 *
 * Writing it: the URL is the only place the requested tab lives, so every writer navigates, and
 * the *resolved* tab is deliberately never written back - see the refusal cases below.
 */

const orgQuery = vi.hoisted(() => ({
  current: { data: undefined as IOrganizationDocument | undefined, isLoading: true },
}));
const searchParams = vi.hoisted(() => ({ current: {} as { tab?: string } }));
const user = vi.hoisted(() => ({ current: { id: 'owner1' } as { id: string; isAdmin?: boolean } | null }));
const navigateSpy = vi.hoisted(() => vi.fn());

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptionsByOwner: () => ({ data: [] }),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetOrganization: () => orgQuery.current,
  useOrganizationSeats: () => ({ currentSeats: 1, maxSeats: 5, pendingSeats: 0, availableSeats: 4 }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));

vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => undefined }));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'org1' }),
  useSearch: () => searchParams.current,
  useNavigate: () => navigateSpy,
}));

vi.mock('@client/app/components/common/Breadcrumbs', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/Member', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationGroups', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationBillingSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationSettingsSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationUsageSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationAnalysisSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrgSlackIntegration', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrgWebhookConfig', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrgGitHubConnectionTab', () => ({ default: () => null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => {
      const value = key.split('.').reduce<unknown>((node, part) => (node as never)?.[part], en);
      return typeof value === 'string' ? value : key;
    },
  }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const ORG = {
  id: 'org1',
  name: 'Acme',
  userId: 'owner1',
  managerId: null,
  personal: false,
  adminUserIds: [],
  seats: 5,
  currentCredits: 100,
  description: 'A team',
  storageLimit: 0,
  users: [
    { userId: 'owner1' },
    // Holds manage permissions but is neither owner nor manager: the one caller for whom the two
    // gates disagree, so a deep link must be honoured for Settings and refused for Usage.
    { userId: 'manager2', permissions: [Permission.read, Permission.update] },
  ],
} as unknown as IOrganizationDocument;

const wrapper = (children: ReactNode) => <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>;

/** Mounts while the org query is still in flight, then delivers the document, as a real load does. */
const renderThroughLoad = () => {
  orgQuery.current = { data: undefined, isLoading: true };
  const { rerender } = render(wrapper(<OrganizationPage />));
  orgQuery.current = { data: ORG, isLoading: false };
  rerender(wrapper(<OrganizationPage />));
  return rerender;
};

/** Feeds the last navigate() back in as the new URL and rerenders, which is all the router does. */
const applyNavigation = (rerender: (ui: ReactNode) => void) => {
  const last = navigateSpy.mock.calls.at(-1)?.[0] as { search?: { tab?: string } } | undefined;
  searchParams.current = { tab: last?.search?.tab };
  rerender(wrapper(<OrganizationPage />));
};

const tabClick = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

const navigationTo = (tab: OrganizationTabs) => ({
  to: '/organizations/$id',
  params: { id: 'org1' },
  search: { tab },
  replace: true,
});

const selectedTabName = () =>
  screen.getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent;

describe('organization detail page - ?tab= deep link', () => {
  beforeEach(() => {
    searchParams.current = {};
    user.current = { id: 'owner1' };
    navigateSpy.mockClear();
  });

  it('opens the Usage tab for the owner, who may see it', () => {
    searchParams.current = { tab: 'usage' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Usage');
  });

  it('opens the Analysis tab for the owner, who may see it', () => {
    searchParams.current = { tab: 'analysis' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Analysis');
  });

  it('opens the Settings tab for the owner, who may manage the org', () => {
    searchParams.current = { tab: 'settings' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Settings');
  });

  it('still falls back to Overview for a member who may not see Usage', () => {
    searchParams.current = { tab: 'usage' };
    user.current = { id: 'manager2' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Overview');
    expect(screen.queryByRole('tab', { name: 'Usage' })).toBeNull();
  });

  // The same caller, the same load, opposite answers: honouring a deep link is per-gate, not a
  // blanket "trust the URL once the org lands".
  it('honours Settings but not Usage for a member who may manage the org', () => {
    searchParams.current = { tab: 'settings' };
    user.current = { id: 'manager2' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Settings');
  });

  it('opens the Billing tab for the owner, the only caller its actions accept', () => {
    searchParams.current = { tab: 'billing' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Billing');
  });

  // Same caller, same manage permissions, opposite answer to the Settings case above: Billing
  // rides its own owner-only gate because Subscribe, Manage Seats and Billing Portal all reject a
  // non-owner. Before the split this member got the whole tab and an error from every control.
  it('refuses Billing for a member who may manage the org', () => {
    searchParams.current = { tab: 'billing' };
    user.current = { id: 'manager2' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Overview');
    expect(screen.queryByRole('tab', { name: 'Billing' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy();
  });

  it('falls back to Overview for a non-member', () => {
    searchParams.current = { tab: 'settings' };
    user.current = { id: 'stranger9' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Overview');
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
  });

  it('defaults to Overview when no tab is named', () => {
    renderThroughLoad();

    expect(selectedTabName()).toBe('Overview');
  });
});

describe('organization detail page - a tab click writes ?tab= back', () => {
  beforeEach(() => {
    searchParams.current = {};
    user.current = { id: 'owner1' };
    navigateSpy.mockClear();
  });

  it('names the clicked tab in the URL', () => {
    renderThroughLoad();

    tabClick('Members');

    expect(navigateSpy).toHaveBeenCalledWith(navigationTo(OrganizationTabs.Members));
  });

  // replace, not push: five tab clicks must not put five entries on the back stack, or Back stops
  // leaving the page.
  it('replaces the history entry rather than pushing one', () => {
    renderThroughLoad();

    tabClick('Billing');

    expect(navigateSpy).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });

  it('selects the clicked tab once the URL carries it', () => {
    const rerender = renderThroughLoad();

    tabClick('Billing');
    applyNavigation(rerender);

    expect(selectedTabName()).toBe('Billing');
  });

  // The page holds no tab state of its own, so a URL it did not originate - Back, a pasted link,
  // any other navigation - moves it too. With a local copy the click would win and the two would
  // silently disagree.
  it('follows a ?tab= change it did not originate', () => {
    const rerender = renderThroughLoad();

    tabClick('Billing');
    searchParams.current = { tab: 'members' };
    rerender(wrapper(<OrganizationPage />));

    expect(selectedTabName()).toBe('Members');
  });

  it('writes ?tab=settings when the header Organization Settings button is clicked', () => {
    renderThroughLoad();

    fireEvent.click(screen.getByRole('button', { name: /Organization Settings/ }));

    expect(navigateSpy).toHaveBeenCalledWith(navigationTo(OrganizationTabs.Settings));
  });

  // The header grants its own button on isAdmin while the page's canManageOrg does not, so a
  // platform admin who is not a member sees a button the page refuses to act on. That disagreement
  // predates the URL sync and is left as found; what is pinned here is that the page-side guard is
  // still what decides, and a refusal writes nothing.
  it('leaves the URL alone when the page refuses the header settings click', () => {
    user.current = { id: 'admin9', isAdmin: true };

    renderThroughLoad();
    fireEvent.click(screen.getByRole('button', { name: /Organization Settings/ }));

    expect(navigateSpy).not.toHaveBeenCalled();
  });

  // Rewriting ?tab=usage to ?tab=overview for a caller who may not see Usage destroys the link for
  // them if access is granted later, and makes one shared URL mean different things to different
  // people. The URL carries the request; only the rendering resolves it.
  it('does not rewrite a ?tab= the gate refused', () => {
    searchParams.current = { tab: 'usage' };
    user.current = { id: 'manager2' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Overview');
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('does not rewrite a ?tab= naming no tab at all', () => {
    searchParams.current = { tab: 'notarealtab' };

    renderThroughLoad();

    expect(selectedTabName()).toBe('Overview');
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
