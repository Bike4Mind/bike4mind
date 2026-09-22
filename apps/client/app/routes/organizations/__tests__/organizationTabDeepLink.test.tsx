// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, Permission } from '@bike4mind/common';
import en from '@client/app/locales/en.json';
import OrganizationPage from '../$id';

/**
 * A ?tab= deep link is resolved against access rules that are derived from the org document, and
 * that document arrives one render AFTER mount. These pin the deep link surviving that window:
 * a gate evaluated against not-yet-loaded data reads "no access" for everyone, so a reset applied
 * on that first pass discards the caller's intent before the answer is knowable.
 */

const orgQuery = vi.hoisted(() => ({
  current: { data: undefined as IOrganizationDocument | undefined, isLoading: true },
}));
const searchParams = vi.hoisted(() => ({ current: {} as { tab?: string } }));
const user = vi.hoisted(() => ({ current: { id: 'owner1' } as { id: string; isAdmin?: boolean } | null }));

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
};

const selectedTabName = () =>
  screen.getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent;

describe('organization detail page - ?tab= deep link', () => {
  beforeEach(() => {
    searchParams.current = {};
    user.current = { id: 'owner1' };
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
