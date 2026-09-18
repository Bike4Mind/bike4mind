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
import OrganizationListPage from '../index';

/**
 * The org read now returns non-terminal rows, so a dunning org reaches this card instead of
 * arriving as an empty list. Without a delinquency branch the card would have flipped from
 * "No Subscription" (today) to a green "Active Subscription" - a false green, since
 * server/entitlements denies a past_due org access. These pin the chip that replaced it.
 */

const subscriptionsData = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptionsByOwner: () => ({ data: subscriptionsData.current }),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetUserOrganizations: () => ({ data: [ORG], isLoading: false, isFetching: false }),
  useOrganizationSeats: () => ({ currentSeats: 1 }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'owner1' } }),
}));

vi.mock('@client/app/components/organizations/CreateTeamModal', () => ({
  useCreateTeamModal: () => vi.fn(),
}));

vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => undefined }));
vi.mock('@client/app/components/help', () => ({ ContextHelpButton: () => null }));
vi.mock('@client/app/utils/s3', () => ({ getAppFileUrl: () => 'https://files.example.com/logo' }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

// Resolve through the real locale file rather than echoing the key back, so a chip wired to a
// key that does not exist (or a renamed key) fails here instead of rendering the key string.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      const value = key.split('.').reduce<unknown>((node, part) => (node as never)?.[part], en);
      if (typeof value !== 'string') return key;
      return options?.count === undefined ? value : value.replace('{{count}}', String(options.count));
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

const renderList = () => {
  const wrapper = (children: ReactNode) => <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>;
  return render(wrapper(<OrganizationListPage />));
};

describe('organization list card - plan chip', () => {
  beforeEach(() => {
    subscriptionsData.current = [];
  });

  it('shows a Payment Issue chip for a dunned org, never a green Active Subscription', () => {
    subscriptionsData.current = [row('past_due')];

    renderList();

    expect(screen.getByText('Payment Issue')).toBeTruthy();
    expect(screen.queryByText('Active Subscription')).toBeNull();
    expect(screen.queryByText('No Subscription')).toBeNull();
  });

  it('still shows Active Subscription for a paid-up org', () => {
    subscriptionsData.current = [row('active')];

    renderList();

    expect(screen.getByText('Active Subscription')).toBeTruthy();
    expect(screen.queryByText('Payment Issue')).toBeNull();
  });

  it('still shows No Subscription for an org with no rows', () => {
    renderList();

    expect(screen.getByText('No Subscription')).toBeTruthy();
    expect(screen.queryByText('Payment Issue')).toBeNull();
  });

  it('prefers the live row over a stale delinquent one, so a recovered org reads Active', () => {
    // A re-subscribe after a failed renewal can leave the old row behind; picking it would
    // paint a healthy org as delinquent.
    subscriptionsData.current = [row('past_due'), { ...row('active'), subscriptionId: 'sub_live' }];

    renderList();

    expect(screen.getByText('Active Subscription')).toBeTruthy();
    expect(screen.queryByText('Payment Issue')).toBeNull();
  });
});
