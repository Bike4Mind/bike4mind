import { useState, type ReactNode } from 'react';
import { vi } from 'vitest';
import type { StripeData } from './stripeSections';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminSubscriptionStripeState } from '@client/app/hooks/data/adminSubscriptionDetail';
import type { AdminSubscriptionDetail, AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionDetail';
import { UndoToastProvider } from '../../shared';

const appTheme = extendTheme({ ...getThemeConfig() });

/** Theme, a fresh QueryClient and the UndoToast provider the detail views and dialogs need. */
export const SubscriptionTestWrapper = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <UndoToastProvider>{children}</UndoToastProvider>
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

export const SUBSCRIPTION_ID = '1'.repeat(24);
export const OWNER_ID = '2'.repeat(24);

export const buildRow = (overrides: Partial<AdminSubscriptionRow> = {}): AdminSubscriptionRow => ({
  id: SUBSCRIPTION_ID,
  subscriptionId: 'admin_grant_1',
  ownerType: 'User',
  ownerId: OWNER_ID,
  ownerAlert: null,
  owner: {
    kind: 'User',
    id: OWNER_ID,
    name: 'Ada Lovelace',
    username: 'ada',
    email: 'ada@example.com',
    stripeCustomerId: null,
  },
  plan: { priceId: 'price_pro', name: 'Pro', interval: 'monthly' },
  billedInterval: null,
  status: 'active',
  source: 'admin_grant',
  quantity: 1,
  customCreditsPerCycle: null,
  mrr: null,
  periodStartsAt: '2026-10-01T00:00:00.000Z',
  periodEndsAt: '2026-12-01T00:00:00.000Z',
  canceledAt: null,
  cancelAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

/** A comped user subscription by default; tests override only what they assert on. */
export const buildDetail = (
  overrides: Partial<Omit<AdminSubscriptionDetail, 'subscription'>> & {
    subscription?: Partial<AdminSubscriptionRow>;
  } = {}
): AdminSubscriptionDetail => {
  const { subscription, ...rest } = overrides;
  return {
    subscription: buildRow(subscription),
    grantedBy: 'admin@example.com',
    grantedReason: 'Pilot',
    credits: { defaultPerCycle: 1000, customPerCycle: null, effectivePerCycle: 1000, recentGrants: [] },
    ownerCredits: 2500,
    otherSubscriptions: [],
    seats: null,
    actingUserId: OWNER_ID,
    stripe: null,
    ...rest,
  };
};

export const ORG_ID = '3'.repeat(24);

/** A comped organization whose billing owner, not the org, is the user the per-user routes act as. */
export const buildOrgDetail = (): AdminSubscriptionDetail =>
  buildDetail({
    subscription: {
      ownerType: 'Organization',
      ownerId: ORG_ID,
      owner: {
        kind: 'Organization',
        id: ORG_ID,
        name: 'Acme',
        stripeCustomerId: null,
        seats: 5,
        memberCount: 3,
        billingOwnerId: 'billing-owner',
      },
    },
    actingUserId: 'billing-owner',
  });

/** A live Stripe-billed row. */
export const STRIPE_ROW: Partial<AdminSubscriptionRow> = { source: 'stripe', subscriptionId: 'sub_123' };

/** A Stripe read that has loaded a healthy subscription; override what a test asserts on. */
export const buildStripeData = (overrides: Partial<StripeData> = {}): StripeData => ({
  stripeConfigured: true,
  kind: 'stripe',
  fetchedAt: '2026-11-01T00:00:00.000Z',
  paymentMethod: { type: 'card', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2099 },
  invoices: [],
  invoicesTruncated: false,
  lifetimePaid: [],
  upcoming: null,
  ...overrides,
});

export const buildStripeState = (
  overrides: Partial<AdminSubscriptionStripeState> = {}
): AdminSubscriptionStripeState => ({
  data: buildStripeData(),
  isLoading: false,
  isError: false,
  isFetching: false,
  refetchFresh: vi.fn(),
  ...overrides,
});
