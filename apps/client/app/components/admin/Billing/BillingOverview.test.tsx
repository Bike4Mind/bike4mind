import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BillingOverview as BillingOverviewData } from '@client/app/utils/adminBillingOverview';
import { ProfileTestWrapper } from '../Users/Profile/profileTestUtils';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  navigate: vi.fn(),
  user: { current: { id: 'admin', isAdmin: true } as Record<string, unknown> },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: (...args: unknown[]) => mocks.get(...args) } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.user.current }) }));

import { BillingOverview } from './BillingOverview';

const USER_ID = 'a'.repeat(24);
const ORG_ID = 'b'.repeat(24);

const overview = (overrides: Partial<BillingOverviewData> = {}): BillingOverviewData => ({
  owner: { type: 'user', id: USER_ID, name: 'Ada', internal: false },
  window: { range: '90d', from: '2026-08-03T12:00:00.000Z', to: '2026-11-01T12:00:00.000Z' },
  generatedAt: '2026-11-01T12:00:00.000Z',
  subscription: {
    status: 'ok',
    standing: 'paid',
    current: {
      id: 'sub-local',
      planName: 'Pro',
      status: 'active',
      source: 'stripe',
      comped: false,
      quantity: 1,
      periodEndsAt: '2026-12-01T00:00:00.000Z',
      cancelAt: null,
      canceledAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    previous: [],
  },
  credits: {
    status: 'ok',
    available: 1_500,
    held: 40,
    heldRequests: 1,
    funding: { purchased: 1_000, subscription: 500, granted: 0, unknown: 0 },
  },
  payments: {
    status: 'ok',
    totals: [
      {
        currency: 'eur',
        creditPurchases: { count: 0, amount: 0 },
        subscriptionPayments: { count: 1, amount: 900 },
        refunds: { count: 0, amount: 0 },
        disputes: { count: 0, amount: 0 },
      },
      {
        currency: 'usd',
        creditPurchases: { count: 1, amount: 1_000 },
        subscriptionPayments: { count: 1, amount: 2_900 },
        refunds: { count: 1, amount: 600 },
        disputes: { count: 0, amount: 0 },
      },
    ],
    records: [
      {
        id: 'refund:ch_1',
        kind: 'refund',
        at: '2026-10-30T00:00:00.000Z',
        amount: 600,
        currency: 'usd',
        label: 'Partial refund of a credit purchase',
        status: 'refunded',
        credits: null,
        paymentIntentId: 'pi_pack',
        link: { kind: 'userCredits', userId: USER_ID },
      },
      {
        id: 'purchase:tx1',
        kind: 'credit_purchase',
        at: '2026-10-27T00:00:00.000Z',
        amount: 1_000,
        currency: 'usd',
        label: '1,000 credits purchased',
        status: 'completed',
        credits: 1_000,
        paymentIntentId: 'pi_pack',
        link: { kind: 'userCredits', userId: USER_ID },
      },
      {
        id: 'invoice:in_1',
        kind: 'subscription_payment',
        at: '2026-10-22T00:00:00.000Z',
        amount: null,
        currency: 'usd',
        label: 'Renewal',
        status: 'paid',
        credits: null,
        paymentIntentId: 'pi_inv',
        link: { kind: 'subscription', subscriptionId: 'sub-local', tab: 'invoices' },
      },
    ],
    truncated: false,
    eventsRecordedSince: '2026-09-01T00:00:00.000Z',
  },
  usage: {
    status: 'ok',
    lastSuccessfulAt: '2026-10-31T12:00:00.000Z',
    attribution: [
      {
        billedTo: 'organization',
        billedToId: ORG_ID,
        billedToName: 'Acme',
        actorUserId: USER_ID,
        actorName: 'Ada',
        credits: 4_000,
        events: 1,
        lastAt: '2026-10-30T12:00:00.000Z',
        link: { kind: 'organization', organizationId: ORG_ID },
      },
      {
        billedTo: 'user',
        billedToId: USER_ID,
        billedToName: 'Ada',
        actorUserId: USER_ID,
        actorName: 'Ada',
        credits: 350,
        events: 2,
        lastAt: '2026-10-31T12:00:00.000Z',
        link: null,
      },
    ],
    truncated: false,
    recordedSince: '2026-01-01T00:00:00.000Z',
    link: { kind: 'userActivity', userId: USER_ID, from: '2026-08-03', to: '2026-11-01' },
  },
  activity: {
    status: 'ok',
    items: [
      {
        id: 'activity:credit:tx1',
        at: '2026-10-27T00:00:01.000Z',
        kind: 'credit_issued',
        summary: 'Credits from a purchase',
        credits: 1_000,
        amount: null,
        currency: null,
        verifiedLinkTo: 'activity:purchase:tx1',
        link: null,
      },
      {
        id: 'activity:purchase:tx1',
        at: '2026-10-27T00:00:00.000Z',
        kind: 'payment',
        summary: '1,000 credits purchased',
        credits: null,
        amount: 1_000,
        currency: 'usd',
        verifiedLinkTo: null,
        link: { kind: 'userCredits', userId: USER_ID },
      },
      {
        id: 'activity:credit:grant',
        at: '2026-10-26T00:00:00.000Z',
        kind: 'credit_issued',
        summary: 'Credits granted',
        credits: 500,
        amount: null,
        currency: null,
        verifiedLinkTo: null,
        link: null,
      },
      {
        id: 'activity:usage:2026-10-25:',
        at: '2026-10-25T23:59:59.999Z',
        kind: 'consumption',
        summary: '3 requests',
        credits: -120,
        amount: null,
        currency: null,
        verifiedLinkTo: null,
        link: null,
      },
    ],
    truncated: false,
  },
  ...overrides,
});

const renderOverview = (onRangeChange = vi.fn(), ownerType: 'user' | 'organization' = 'user') =>
  render(<BillingOverview ownerType={ownerType} ownerId={USER_ID} range="90d" onRangeChange={onRangeChange} />, {
    wrapper: ProfileTestWrapper,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.current = { id: 'admin', isAdmin: true };
  mocks.get.mockResolvedValue({ data: overview() });
});

describe('BillingOverview', () => {
  it('asks for the owner and window it was given', async () => {
    renderOverview(vi.fn(), 'organization');
    await screen.findByTestId('billing-subscription-card');
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/billing-overview', {
      params: { ownerType: 'organization', ownerId: USER_ID, range: '90d' },
    });
  });

  it('shows standing, renewal, balance with held credits apart, and funding sources', async () => {
    renderOverview();
    const subscription = await screen.findByTestId('billing-subscription-card');
    expect(within(subscription).getByTestId('billing-subscription-standing')).toHaveTextContent('Paid');
    expect(within(subscription).getByTestId('billing-subscription-next')).toHaveTextContent('1 Dec 2026');
    expect(within(subscription).getByTestId('billing-subscription-link')).toHaveAttribute(
      'href',
      '/admin/subscriptions/sub-local'
    );
    expect(screen.getByTestId('billing-credits-available')).toHaveTextContent('1,500 credits');
    expect(screen.getByTestId('billing-credits-held')).toHaveTextContent('40 credits (1 request)');
    expect(screen.getByTestId('billing-credits-funding-purchased')).toHaveTextContent('1,000');
    expect(screen.getByTestId('billing-credits-funding-unknown')).toHaveTextContent('0');
  });

  it('totals each currency on its own row and marks a payment with no amount', async () => {
    renderOverview();
    const totals = await screen.findByTestId('billing-payment-totals');
    expect(within(totals).getByText('EUR')).toBeInTheDocument();
    expect(within(totals).getByText('\u20ac9.00')).toBeInTheDocument();
    expect(within(totals).getByText('$29.00')).toBeInTheDocument();
    const invoiceRow = screen.getByTestId('billing-payment-row-invoice:in_1');
    expect(within(invoiceRow).getByText('No amount')).toBeInTheDocument();
    expect(screen.getByTestId('billing-payment-link-invoice:in_1')).toHaveAttribute(
      'href',
      '/admin/subscriptions/sub-local?tab=invoices'
    );
    expect(screen.getByTestId('billing-payments-coverage')).toHaveTextContent('recorded from 1 Sept 2026 on');
  });

  it('says the coverage date is unknown, not that no events exist, when it could not be read', async () => {
    const base = overview();
    if (base.payments.status !== 'ok') throw new Error('fixture payments unavailable');
    mocks.get.mockResolvedValue({
      data: overview({ payments: { ...base.payments, eventsRecordedSince: null, eventsCoverageUnknown: true } }),
    });
    renderOverview();
    const note = await screen.findByTestId('billing-payments-coverage');
    expect(note).toHaveTextContent('could not be loaded');
    expect(note).not.toHaveTextContent('No Stripe events are recorded yet');
  });

  it('lists own and organization-billed usage apart and links to the activity view', async () => {
    renderOverview();
    const table = await screen.findByTestId('billing-usage-table');
    expect(within(table).getByText('Own balance')).toBeInTheDocument();
    expect(within(table).getByText('Acme')).toHaveAttribute('href', `/admin?tab=organizations&orgId=${ORG_ID}`);
    expect(within(table).queryByText('4,350')).not.toBeInTheDocument();
    expect(screen.getByTestId('billing-usage-activity-link')).toHaveAttribute(
      'href',
      `/admin/users/${USER_ID}?tab=activity&types=usage%2Cspend&from=2026-08-03&to=2026-11-01`
    );
  });

  it('ties credits to a payment only where the record says so', async () => {
    renderOverview();
    await screen.findByTestId('billing-activity-card');
    expect(screen.getByTestId('billing-activity-verified-activity:credit:tx1')).toHaveTextContent(
      'from 1,000 credits purchased, same Stripe payment'
    );
    expect(screen.queryByTestId('billing-activity-verified-activity:credit:grant')).not.toBeInTheDocument();
    expect(screen.getByTestId('billing-activity-activity:usage:2026-10-25:')).toHaveTextContent('-120 credits');
  });

  it('navigates inside the app on a plain click and leaves modified clicks to the browser', async () => {
    renderOverview();
    const link = await screen.findByTestId('billing-subscription-link');
    fireEvent.click(link);
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/admin/subscriptions/sub-local' });
    mocks.navigate.mockClear();
    fireEvent.click(link, { metaKey: true });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('keeps the other sections when one source is unavailable', async () => {
    mocks.get.mockResolvedValue({
      data: overview({ payments: { status: 'unavailable', message: 'The Stripe events could not be loaded.' } }),
    });
    renderOverview();
    expect(await screen.findByTestId('billing-payments-unavailable')).toHaveTextContent(
      'The Stripe events could not be loaded.'
    );
    expect(screen.getByTestId('billing-credits-available')).toHaveTextContent('1,500 credits');
  });

  it('shows a no-subscription account with only credit purchases', async () => {
    mocks.get.mockResolvedValue({
      data: overview({ subscription: { status: 'ok', standing: 'none', current: null, previous: [] } }),
    });
    renderOverview();
    const card = await screen.findByTestId('billing-subscription-card');
    expect(within(card).getByTestId('billing-subscription-standing')).toHaveTextContent('No subscription');
    expect(within(card).queryByTestId('billing-subscription-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('billing-payment-row-purchase:tx1')).toBeInTheDocument();
  });

  it('shows the empty states', async () => {
    const base = overview();
    mocks.get.mockResolvedValue({
      data: overview({
        payments: {
          ...(base.payments as Extract<BillingOverviewData['payments'], { status: 'ok' }>),
          totals: [],
          records: [],
        },
        usage: {
          ...(base.usage as Extract<BillingOverviewData['usage'], { status: 'ok' }>),
          attribution: [],
          lastSuccessfulAt: null,
        },
        activity: { status: 'ok', items: [], truncated: false },
      }),
    });
    renderOverview();
    expect(await screen.findByTestId('billing-payments-empty')).toBeInTheDocument();
    expect(screen.getByTestId('billing-usage-empty')).toBeInTheDocument();
    expect(screen.getByTestId('billing-usage-last')).toHaveTextContent('never recorded');
    expect(screen.getByTestId('billing-activity-empty')).toBeInTheDocument();
  });

  it('reports a failed request with a retry', async () => {
    mocks.get.mockRejectedValueOnce(new Error('boom'));
    renderOverview();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('could not be loaded');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    await waitFor(() => expect(screen.getByTestId('billing-subscription-card')).toBeInTheDocument());
  });

  it('changes the window through its owner', async () => {
    const onRangeChange = vi.fn();
    renderOverview(onRangeChange);
    await screen.findByTestId('billing-subscription-card');
    fireEvent.click(screen.getByTestId('billing-range-365d'));
    expect(onRangeChange).toHaveBeenCalledWith('365d');
  });

  it('shows a delegate without a billing read permission the missing-permission state and fetches nothing', () => {
    mocks.user.current = { id: 'delegate', isAdmin: false, adminPermissions: ['users:moderate'] };
    renderOverview();
    expect(screen.getByTestId('admin-missing-permission-state')).toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
