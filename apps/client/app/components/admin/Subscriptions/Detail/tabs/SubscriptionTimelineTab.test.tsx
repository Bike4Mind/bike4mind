import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { SUBSCRIPTION_ID, SubscriptionTestWrapper } from '../subscriptionDetailTestUtils';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));

import { SubscriptionTimelineTab } from './SubscriptionTimelineTab';

const billing = {
  kind: 'billing',
  id: '1'.repeat(24),
  occurredAt: '2026-10-21T09:00:00.000Z',
  type: 'invoice.payment_failed',
  summary: 'Payment failed (attempt 1), dunning email sent',
  stripeEventId: 'evt_1',
  amount: 1900,
  currency: 'usd',
  data: { invoiceId: 'in_1', attemptCount: 1, dunningNoticeSent: true },
};
const admin = {
  kind: 'admin',
  id: '2'.repeat(24),
  occurredAt: '2026-10-20T09:00:00.000Z',
  type: 'user.profile.updated',
  summary: 'updated isBanned',
  audit: makeAuditEntry({
    id: '2'.repeat(24),
    action: 'user.profile.updated',
    reason: 'Chargeback',
    changes: [{ field: 'isBanned', before: false, after: true }],
  }),
};
const credit = {
  kind: 'credit',
  id: '3'.repeat(24),
  occurredAt: '2026-10-19T09:00:00.000Z',
  type: 'subscription',
  summary: 'Plan credits granted: +5,000 credits',
  credits: 5000,
};

const path = `/api/admin/subscriptions/${SUBSCRIPTION_ID}/timeline`;
const lastParams = () => (mocks.get.mock.calls.at(-1)?.[1] as { params: Record<string, string> }).params;

const renderTab = () =>
  render(<SubscriptionTimelineTab subscriptionId={SUBSCRIPTION_ID} />, { wrapper: SubscriptionTestWrapper });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SubscriptionTimelineTab', () => {
  it('renders every source in server order, with money through the shared formatter', async () => {
    mocks.get.mockResolvedValue({ data: { items: [billing, admin, credit], nextCursor: null } });
    renderTab();

    const rows = await screen.findAllByTestId('subscription-timeline-row');
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Payment failed (attempt 1), dunning email sent'),
      expect.stringContaining('Suspended account'),
      expect.stringContaining('Plan credits granted: +5,000 credits'),
    ]);
    expect(rows[0]).toHaveTextContent('$19.00');
    expect(rows[0]).toHaveTextContent('in_1');
    expect(rows[1]).toHaveTextContent('Reason: Chargeback');
    expect(mocks.get).toHaveBeenCalledWith(path, { params: { limit: '100' } });
    expect(screen.getByTestId('subscription-timeline-filter-all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('subscription-timeline-more-btn')).not.toBeInTheDocument();
  });

  it('asks the endpoint for one kind when a filter is picked', async () => {
    mocks.get.mockResolvedValue({ data: { items: [billing, admin, credit], nextCursor: null } });
    renderTab();
    await screen.findAllByTestId('subscription-timeline-row');

    mocks.get.mockResolvedValue({ data: { items: [billing], nextCursor: null } });
    fireEvent.click(screen.getByTestId('subscription-timeline-filter-billing'));

    await waitFor(() => expect(lastParams()).toEqual({ limit: '100', kind: 'billing' }));
    await waitFor(() => expect(screen.getAllByTestId('subscription-timeline-row')).toHaveLength(1));
    expect(screen.getByTestId('subscription-timeline-filter-billing')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the empty state, and a way back to every type when a filter empties it', async () => {
    mocks.get.mockResolvedValue({ data: { items: [], nextCursor: null } });
    renderTab();

    expect(await screen.findByText('Nothing on the timeline yet')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('subscription-timeline-filter-credit'));
    expect(await screen.findByText('Nothing of this type yet')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('subscription-timeline-show-all-btn'));
    expect(await screen.findByText('Nothing on the timeline yet')).toBeInTheDocument();
    expect(screen.getByTestId('subscription-timeline-filter-all')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows an error state with a retry', async () => {
    mocks.get.mockRejectedValue(new Error('boom'));
    renderTab();

    expect(await screen.findByText('The timeline could not be loaded.')).toBeInTheDocument();
  });

  it('loads the next page from the cursor', async () => {
    mocks.get.mockResolvedValueOnce({ data: { items: [billing], nextCursor: 'next-1' } });
    renderTab();

    mocks.get.mockResolvedValueOnce({ data: { items: [credit], nextCursor: null } });
    fireEvent.click(await screen.findByTestId('subscription-timeline-more-btn'));

    await waitFor(() => expect(screen.getAllByTestId('subscription-timeline-row')).toHaveLength(2));
    expect(lastParams()).toEqual({ limit: '100', cursor: 'next-1' });
  });
});
