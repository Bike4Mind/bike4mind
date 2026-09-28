// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument } from '@bike4mind/common';
import { SubscriptionSource } from '@client/lib/subscriptions/types';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@client/lib/subscriptions/constants';
import en from '@client/app/locales/en.json';
import OrganizationPage from '../$id';

/**
 * The detail page is the only widened surface that recomputes the plan chip locally, in both
 * OrganizationHeader and OrganizationOverviewSection. organizationPlanChip covers
 * routes/organizations/index, not this route, so without these a revert of either branch to the
 * old `!canceledAt` check stays green while a dunning org reads "Team Plan" on its own page.
 * Rendering the route exercises both through the real pickDisplayedSubscription path.
 */

const subscriptionsData = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptionsByOwner: () => ({ data: subscriptionsData.current }),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetOrganization: () => ({ data: ORG, isLoading: false }),
  useOrganizationSeats: () => ({ currentSeats: 1, maxSeats: 5, pendingSeats: 0, availableSeats: 4 }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'owner1' } }),
}));

vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => undefined }));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'org1' }),
  useSearch: () => ({}),
  // The page writes the selected tab to the URL; nothing here clicks a tab, so it only has to exist.
  useNavigate: () => vi.fn(),
}));

// The route imports eight sibling panels; mocking them keeps this test to the two chips it pins.
vi.mock('@client/app/components/common/Breadcrumbs', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/Member', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationGroups', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationBillingSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationSettingsSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrganizationUsageSection', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrgSlackIntegration', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrgWebhookConfig', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/OrgGitHubConnectionTab', () => ({ default: () => null }));

// Resolve through the real locale file, so a renamed or missing key fails here rather than
// rendering the key string. i18n.language feeds the overview card's date formatting.
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
  seats: 5,
  currentCredits: 100,
  description: 'A team',
  logo: undefined,
  billingContact: null,
  storageLimit: 0,
  users: [{ userId: 'u1' }],
} as unknown as IOrganizationDocument;

const row = (status: string) => ({
  ownerType: 'Organization',
  ownerId: 'org1',
  subscriptionId: `sub_${status}`,
  priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
  status,
  source: SubscriptionSource.Stripe,
  canceledAt: null,
  periodStartsAt: new Date('2026-01-01T00:00:00Z'),
  periodEndsAt: new Date('2026-02-01T00:00:00Z'),
  quantity: 5,
});

const renderPage = () => {
  const wrapper = (children: ReactNode) => <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>;
  return render(wrapper(<OrganizationPage />));
};

describe('organization detail page - plan chip', () => {
  beforeEach(() => {
    subscriptionsData.current = [];
  });

  it('reads a dunned org as Payment Issue in both the header and the overview card', () => {
    subscriptionsData.current = [row('past_due')];

    renderPage();

    // Two chips, one per branch - a revert of either leaves one reading "Team Plan".
    expect(screen.getAllByText('Payment Issue')).toHaveLength(2);
    expect(screen.queryByText('Team Plan')).toBeNull();
    expect(screen.queryByText('No Active Plan')).toBeNull();
  });

  it('still reads a paid-up org as Team Plan', () => {
    subscriptionsData.current = [row('active')];

    renderPage();

    expect(screen.getAllByText('Team Plan')).toHaveLength(2);
    expect(screen.queryByText('Payment Issue')).toBeNull();
  });

  it('reads an org with no rows as having no active plan', () => {
    renderPage();

    expect(screen.getAllByText('No Active Plan')).toHaveLength(2);
    expect(screen.queryByText('Payment Issue')).toBeNull();
  });

  it('prefers the live row over a stale delinquent one, so a recovered org reads Team Plan', () => {
    subscriptionsData.current = [row('past_due'), { ...row('active'), subscriptionId: 'sub_live' }];

    renderPage();

    expect(screen.getAllByText('Team Plan')).toHaveLength(2);
    expect(screen.queryByText('Payment Issue')).toBeNull();
  });
});
