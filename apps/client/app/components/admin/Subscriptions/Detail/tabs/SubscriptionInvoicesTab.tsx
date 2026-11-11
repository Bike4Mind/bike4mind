import React from 'react';
import { Link, Typography } from '@mui/joy';
import type { AdminSubscriptionStripeState } from '@client/app/hooks/data/adminSubscriptionDetail';
import { isCompSubscription, type AdminSubscriptionDetail } from '@client/app/utils/adminSubscriptionDetail';
import { MAX_INVOICES, type AdminStripeInvoice } from '@client/app/utils/adminSubscriptionStripe';
import { DataTable, Dash, EmptyState, StatusChip, formatMoney, type DataColumn } from '../../../shared';
import { formatCredits } from '../../../Users/Profile/actions/creditAdjustment';
import { formatDate } from '../subscriptionDetailModel';
import { StripeSection, invoiceStatusTone } from '../stripeSections';

const fetchedTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

// What the customer was charged once paid; what Stripe asked for otherwise (open, void, uncollectible).
const invoiceAmount = (invoice: AdminStripeInvoice) =>
  invoice.status === 'paid' ? invoice.amountPaid : invoice.amountDue;

const columns = (currencies: string[]): DataColumn<AdminStripeInvoice>[] => [
  { id: 'number', label: 'Number', render: invoice => invoice.number ?? invoice.id },
  {
    id: 'date',
    label: 'Date',
    sortValue: invoice => invoice.createdAt,
    render: invoice => formatDate(invoice.createdAt) ?? <Dash />,
  },
  {
    id: 'amount',
    label: currencies.length === 1 ? `Amount (${currencies[0].toUpperCase()})` : 'Amount',
    numeric: true,
    // Amounts in different currencies do not compare, so only a single-currency table sorts by amount.
    sortValue: currencies.length === 1 ? invoiceAmount : undefined,
    render: invoice => formatMoney(invoiceAmount(invoice), invoice.currency),
  },
  {
    id: 'status',
    label: 'Status',
    render: invoice =>
      invoice.status ? (
        <StatusChip tone={invoiceStatusTone(invoice.status)} label={capitalize(invoice.status)} dot />
      ) : (
        <Dash />
      ),
  },
  { id: 'paidAt', label: 'Paid at', render: invoice => formatDate(invoice.paidAt) ?? <Dash /> },
  { id: 'attempts', label: 'Attempts', numeric: true, render: invoice => invoice.attempts },
  {
    id: 'credits',
    label: 'Credits granted',
    numeric: true,
    render: invoice => (
      <span data-testid="subscription-invoices-credits-cell">
        {invoice.creditsGranted === null ? (
          <Dash title="No grant found" data-testid="subscription-invoices-no-grant" />
        ) : (
          formatCredits(invoice.creditsGranted)
        )}
      </span>
    ),
  },
  {
    id: 'link',
    label: 'Invoice',
    render: invoice =>
      invoice.hostedInvoiceUrl ? (
        <Link
          href={invoice.hostedInvoiceUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="subscription-invoices-hosted-link"
        >
          View
        </Link>
      ) : (
        <Dash />
      ),
  },
];

/** Live Stripe invoices next to the credits each one granted (the "charged but no credits" check). */
export const SubscriptionInvoicesTab: React.FC<{
  detail: AdminSubscriptionDetail;
  stripe: AdminSubscriptionStripeState;
}> = ({ detail, stripe }) => {
  if (isCompSubscription(detail.subscription)) {
    return (
      <StripeSection
        stripe={{ ...stripe, data: { stripeConfigured: true, kind: 'comp' } }}
        testIdPrefix="subscription-invoices"
      >
        {() => null}
      </StripeSection>
    );
  }
  return (
    <StripeSection stripe={stripe} testIdPrefix="subscription-invoices">
      {data => (
        <>
          <DataTable
            label="Stripe invoices"
            testId="subscription-invoices-table"
            rowTestId={() => 'subscription-invoices-row'}
            rows={data.invoices}
            getRowId={invoice => invoice.id}
            columns={columns([...new Set(data.invoices.map(invoice => invoice.currency))])}
            onRetry={stripe.refetchFresh}
            empty={<EmptyState title="No invoices yet" action={null} />}
            minWidth="48rem"
          />
          {data.invoicesTruncated && (
            <Typography
              level="body-xs"
              sx={{ mt: 1, color: 'admin.inkMuted' }}
              data-testid="subscription-invoices-truncated"
            >
              Showing the latest {MAX_INVOICES} invoices.
            </Typography>
          )}
          <Typography
            level="body-xs"
            sx={{ mt: 1, color: 'admin.inkMuted' }}
            data-testid="subscription-invoices-fetched-at"
          >
            Fetched from Stripe at {fetchedTime(data.fetchedAt)}.{' '}
            <Link
              component="button"
              level="body-xs"
              onClick={stripe.refetchFresh}
              disabled={stripe.isFetching}
              data-testid="subscription-invoices-refresh-btn"
            >
              Refresh
            </Link>
          </Typography>
        </>
      )}
    </StripeSection>
  );
};
