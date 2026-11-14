// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, Permission } from '@bike4mind/common';
import en from '@client/app/locales/en.json';
import { OrganizationTabs } from '../orgTabAccess';
import OrganizationPage from '../$id';

/**
 * Narrow-screen layout and accessible names of the team page shell.
 * Mocks mirror organizationTabDeepLink.test.tsx.
 */

const orgQuery = vi.hoisted(() => ({
  current: { data: undefined as IOrganizationDocument | undefined, isLoading: true },
}));
const searchParams = vi.hoisted(() => ({ current: {} as { tab?: string } }));
const user = vi.hoisted(() => ({ current: { id: 'owner1' } as { id: string; isAdmin?: boolean } | null }));
const navigateSpy = vi.hoisted(() => vi.fn());
const mobile = vi.hoisted(() => ({ current: false }));
const libraryRender = vi.hoisted(() => vi.fn());

vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.current }));

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptionsByOwner: () => ({ data: [] }),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetOrganization: () => orgQuery.current,
  useOrganizationSeats: () => ({ currentSeats: 1, maxSeats: 5, pendingSeats: 0, availableSeats: 4 }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));

vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => undefined }));
vi.mock('@client/app/components/organizations/OrganizationAvatar', () => ({ default: () => null }));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'org1' }),
  useSearch: () => searchParams.current,
  useNavigate: () => navigateSpy,
}));

vi.mock('@client/app/components/common/Breadcrumbs', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/TeamOnboardingChecklist', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/Member', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationGroups', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationBillingSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationSettingsSection', () => ({
  default: () => <input aria-label="Unsaved settings draft" defaultValue="original" />,
}));
vi.mock('@client/app/components/organizations/OrganizationRetentionSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationUsageSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationAnalysisSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationLibrarySection', () => ({
  default: (props: { organizationId: string; canManage: boolean }) => {
    libraryRender(props);
    return <div data-testid="library-content" />;
  },
}));
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
  personal: false,
  adminUserIds: [],
  seats: 5,
  currentCredits: 100,
  description: 'A team',
  storageLimit: 0,
  users: [
    { userId: 'owner1' },
    // Holds manage permissions but is neither owner nor manager: the one caller for whom the two
    // gates disagree, so the phone select must offer Settings but not Usage.
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

const navigationTo = (tab: OrganizationTabs) => ({
  to: '/organizations/$id',
  params: { id: 'org1' },
  search: { tab },
  replace: true,
});

describe('organization detail page - responsive rail', () => {
  beforeEach(() => {
    searchParams.current = {};
    user.current = { id: 'owner1' };
    navigateSpy.mockClear();
    libraryRender.mockClear();
    mobile.current = false;
  });

  it('shows the vertical tab rail on wide screens', () => {
    renderThroughLoad();

    const rail = screen.getByTestId('organization-tabs');
    expect(rail.getAttribute('aria-label')).toBe('Team sections');
    expect(rail.getAttribute('aria-orientation')).toBe('vertical');
    expect(screen.queryByTestId('organization-tabs-select')).toBeNull();
  });

  it('collapses the rail to a labelled select on phones', () => {
    mobile.current = true;
    searchParams.current = { tab: 'settings' };

    renderThroughLoad();

    expect(screen.queryByTestId('organization-tabs')).toBeNull();
    const select = screen.getByRole('combobox', { name: 'Team section' });
    expect(select.textContent).toContain('Settings');
    // With no Tab elements mounted the panel must still show, and must not point at a missing tab.
    const panel = screen.getByRole('tabpanel');
    expect(panel.textContent).toContain('Team Settings');
    expect(panel.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('preserves drafts and valid panel names through desktop, phone navigation and desktop again', async () => {
    searchParams.current = { tab: 'settings' };
    const rerender = renderThroughLoad();
    const draft = screen.getByRole('textbox', { name: 'Unsaved settings draft' });
    fireEvent.change(draft, { target: { value: 'keep this unsaved draft' } });
    const panels = () => screen.getAllByRole('tabpanel', { hidden: true });
    const expectDesktopLinks = () => {
      for (const panel of panels()) {
        const ids = panel.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean);
        expect(ids?.length).toBeGreaterThan(0);
        for (const id of ids ?? []) {
          const tab = document.getElementById(id);
          expect(tab).not.toBeNull();
          expect(tab).toHaveAttribute('aria-controls', panel.id);
        }
      }
      for (const tab of screen.getAllByRole('tab')) {
        const controlledId = tab.getAttribute('aria-controls');
        if (controlledId) expect(document.getElementById(controlledId)).not.toBeNull();
      }
    };
    await waitFor(expectDesktopLinks);
    mobile.current = true;
    rerender(wrapper(<OrganizationPage />));
    expect(screen.getByRole('textbox', { name: 'Unsaved settings draft' })).toBe(draft);
    expect(draft).toHaveValue('keep this unsaved draft');
    const expectPhoneNames = () => {
      for (const panel of panels()) {
        expect(panel).not.toHaveAttribute('aria-labelledby');
        expect(panel.getAttribute('aria-label')).toBeTruthy();
      }
    };
    expectPhoneNames();
    fireEvent.click(screen.getByRole('combobox', { name: 'Team section' }));
    const listbox = screen.getByRole('listbox', { name: 'Team sections' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(15);
    fireEvent.click(within(listbox).getByRole('option', { name: 'Members' }));
    applyNavigation(rerender);
    expectPhoneNames();
    expect(screen.getByRole('tabpanel', { name: 'Members' })).toBeTruthy();
    mobile.current = false;
    rerender(wrapper(<OrganizationPage />));
    await waitFor(expectDesktopLinks);
    expect(screen.getByRole('tabpanel', { name: 'Members' })).toBeTruthy();
  });

  it('keeps the Library panel linked while mounting its contents only when selected', () => {
    const rerender = renderThroughLoad();
    const libraryTab = screen.getByRole('tab', { name: 'Library' });
    const panelId = libraryTab.getAttribute('aria-controls');
    if (!panelId) throw new Error('Library tab must link to its panel');
    expect(document.getElementById(panelId)).not.toBeNull();
    expect(libraryRender).not.toHaveBeenCalled();

    fireEvent.click(libraryTab);
    applyNavigation(rerender);
    expect(screen.getByRole('tabpanel', { name: 'Library' })).toHaveAttribute('id', panelId);
    expect(screen.getByTestId('library-content')).toBeTruthy();
    expect(libraryRender).toHaveBeenCalledWith({ organizationId: 'org1', canManage: true });

    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    applyNavigation(rerender);
    expect(screen.queryByTestId('library-content')).toBeNull();
    expect(document.getElementById(panelId)).not.toBeNull();
  });

  it('offers only the tabs the viewer may open and navigates on pick', () => {
    mobile.current = true;
    user.current = { id: 'manager2' };

    const rerender = renderThroughLoad();
    fireEvent.click(screen.getByRole('combobox', { name: 'Team section' }));

    const listbox = screen.getByRole('listbox', { name: 'Team sections' });
    const options = within(listbox)
      .getAllByRole('option')
      .map(option => option.textContent);
    expect(options).toEqual(['Overview', 'Members', 'Library', 'Settings']);

    fireEvent.click(within(listbox).getByRole('option', { name: 'Members' }));
    expect(navigateSpy).toHaveBeenLastCalledWith(navigationTo(OrganizationTabs.Members));
    applyNavigation(rerender);
    expect(screen.getByRole('combobox', { name: 'Team section' }).textContent).toContain('Members');
  });
});
