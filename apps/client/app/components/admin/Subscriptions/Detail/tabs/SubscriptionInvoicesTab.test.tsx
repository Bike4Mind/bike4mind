import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AdminStripeInvoice } from '@client/app/utils/adminSubscriptionStripe';
import { SubscriptionInvoicesTab } from './SubscriptionInvoicesTab';
import {
  STRIPE_ROW,
  SubscriptionTestWrapper,
  buildDetail,
  buildStripeData,
  buildStripeState,
} from '../subscriptionDetailTestUtils';

const invoice = (overrides: Partial<AdminStripeInvoice>): AdminStripeInvoice => ({
  id: 'in_1',
  number: 'N-0001',
  createdAt: '2026-10-01T00:00:00.000Z',
  amountDue: 2000,
  amountPaid: 2000,
  currency: 'usd',
  status: 'paid',
  paidAt: '2026-10-01T00:05:00.000Z',
  attempts: 1,
  hostedInvoiceUrl: 'https://invoice.stripe.com/i/1',
  creditsGranted: 1500,
  ...overrides,
});

const renderTab = (stripe = buildStripeState(), comp = false) =>
  render(<SubscriptionInvoicesTab detail={buildDetail(comp ? {} : { subscription: STRIPE_ROW })} stripe={stripe} />, {
    wrapper: SubscriptionTestWrapper,
  });

describe('SubscriptionInvoicesTab', () => {
  it('lists invoices with credits granted and a dash where none was granted', () => {
    renderTab(
      buildStripeState({
        data: buildStripeData({
          invoices: [invoice({}), invoice({ id: 'in_2', number: 'N-0002', creditsGranted: null, status: 'open' })],
        }),
      })
    );
    const rows = screen.getAllByTestId('subscription-invoices-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('N-0001')).toBeInTheDocument();
    expect(within(rows[0]).getByText('$20.00')).toBeInTheDocument();
    expect(within(rows[0]).getByTestId('subscription-invoices-credits-cell')).toHaveTextContent('1,500');
    expect(within(rows[0]).queryByTestId('subscription-invoices-no-grant')).not.toBeInTheDocument();
    expect(within(rows[1]).getByTestId('subscription-invoices-no-grant')).toHaveAttribute(
      'aria-label',
      'No grant found'
    );
    expect(screen.getByText('Amount (USD)')).toBeInTheDocument();
  });

  it('shows what was paid on a paid invoice and what is due otherwise, and drops the currency sort when mixed', () => {
    renderTab(
      buildStripeState({
        data: buildStripeData({
          invoices: [
            invoice({ amountDue: 2000, amountPaid: 1500 }),
            invoice({ id: 'in_2', status: 'open', amountDue: 3000, amountPaid: 0, currency: 'eur' }),
          ],
        }),
      })
    );
    const rows = screen.getAllByTestId('subscription-invoices-row');
    expect(within(rows[0]).getByText('$15.00')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/30\.00/)).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('says when the data was fetched and refreshes past the cache', () => {
    const refetchFresh = vi.fn();
    renderTab(buildStripeState({ data: buildStripeData({ invoices: [invoice({})] }), refetchFresh }));
    expect(screen.getByTestId('subscription-invoices-fetched-at')).toHaveTextContent('Fetched from Stripe');
    fireEvent.click(screen.getByTestId('subscription-invoices-refresh-btn'));
    expect(refetchFresh).toHaveBeenCalled();
  });

  it('links to the hosted invoice in a new tab', () => {
    renderTab(buildStripeState({ data: buildStripeData({ invoices: [invoice({})] }) }));
    const link = screen.getByTestId('subscription-invoices-hosted-link');
    expect(link).toHaveAttribute('href', 'https://invoice.stripe.com/i/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('says so when the list was capped', () => {
    renderTab(buildStripeState({ data: buildStripeData({ invoices: [invoice({})], invoicesTruncated: true }) }));
    expect(screen.getByTestId('subscription-invoices-truncated')).toHaveTextContent('latest 300');
  });

  it('shows the empty state', () => {
    renderTab();
    expect(screen.getByText('No invoices yet')).toBeInTheDocument();
  });

  it('explains a comp has no invoices', () => {
    renderTab(buildStripeState({ data: undefined }), true);
    expect(screen.getByTestId('subscription-invoices-empty')).toHaveTextContent('Comped plans have no Stripe invoices');
  });

  it('shows the Stripe error with Try again', () => {
    const refetchFresh = vi.fn();
    renderTab(buildStripeState({ data: undefined, isError: true, refetchFresh }));
    expect(screen.getByTestId('subscription-invoices-error')).toHaveTextContent("Couldn't reach Stripe");
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetchFresh).toHaveBeenCalled();
  });
});
