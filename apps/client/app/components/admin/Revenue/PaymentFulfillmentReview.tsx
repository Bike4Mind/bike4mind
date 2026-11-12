import React from 'react';
import { Box, Button, Link, Option, Select, Stack, Typography } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  FULFILLMENT_STATES,
  PaymentFulfillmentQuery,
  type PaymentFulfillmentPage,
} from '@client/app/utils/paymentFulfillment';
import { EmptyState, ErrorState, SectionCard } from '../shared';
import { useAdminListUrlState } from '../shared/useAdminListUrlState';
import { adminOrganizationHref } from '../organizationsTabSearch';
import { PAYMENT_REVIEW_SEARCH_KEYS } from './paymentReviewSearch';

export function PaymentFulfillmentReview() {
  const [url, update] = useAdminListUrlState(PAYMENT_REVIEW_SEARCH_KEYS);
  const opened = url.view === 'open';
  const parsed = PaymentFulfillmentQuery.safeParse(
    Object.fromEntries(Object.entries(url.filters).filter(([, value]) => value !== ''))
  );
  const params = parsed.success ? parsed.data : PaymentFulfillmentQuery.parse({});
  const query = useQuery({
    queryKey: ['admin', 'payment-fulfillment', params],
    queryFn: async () => (await api.get<PaymentFulfillmentPage>('/api/admin/payment-fulfillment', { params })).data,
    enabled: opened,
    staleTime: 60_000,
    retry: false,
  });
  const filter = (key: string, value: string) => update({ filters: { ...url.filters, [key]: value, cursor: '' } });
  if (!opened)
    return (
      <Button
        variant="outlined"
        color="neutral"
        onClick={() => update({ view: 'open' })}
        data-testid="payment-review-open-btn"
      >
        Reconciliation: payment fulfillment
      </Button>
    );
  return (
    <SectionCard title="Payment fulfillment reconciliation" body="custom" data-testid="payment-review">
      <Stack gap={2} sx={{ p: 2 }}>
        <Typography level="body-sm">
          Read-only ledger review. Covers payment intents, not invoice-only grants or independent balance delivery.
          Subscription amounts remain unknown without historical entitlement evidence.
        </Typography>
        <Link href="/admin?tab=subscriptions" data-testid="payment-review-subscriptions-link">
          Subscription findings and timelines
        </Link>
        <Stack direction="row" gap={1} flexWrap="wrap">
          <Select
            value={String(params.days)}
            onChange={(_, value) => filter('days', value ?? '7')}
            aria-label="Payment review period"
            data-testid="payment-review-days-select"
          >
            {[1, 7, 30, 90].map(days => (
              <Option key={days} value={String(days)}>
                {days} days
              </Option>
            ))}
          </Select>
          <Select
            value={params.state ?? ''}
            onChange={(_, value) => filter('state', value ?? '')}
            aria-label="Payment review state"
            data-testid="payment-review-state-select"
          >
            <Option value="">All states</Option>
            {FULFILLMENT_STATES.map(state => (
              <Option key={state} value={state}>
                {state}
              </Option>
            ))}
          </Select>
          <Select
            value={params.ownerType ?? ''}
            onChange={(_, value) => filter('ownerType', value ?? '')}
            aria-label="Payment owner type"
            data-testid="payment-review-owner-select"
          >
            <Option value="">All owners</Option>
            <Option value="User">Users</Option>
            <Option value="Organization">Organizations</Option>
          </Select>
          <Button
            variant="outlined"
            color="neutral"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
            data-testid="payment-review-refresh-btn"
          >
            Refresh evidence
          </Button>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => update({ view: '' })}
            data-testid="payment-review-close-btn"
          >
            Close
          </Button>
        </Stack>
        {query.isLoading ? (
          <Typography data-testid="payment-review-loading">Loading provider and ledger evidence...</Typography>
        ) : query.isError ? (
          <ErrorState message="Payment review could not be loaded." onRetry={() => void query.refetch()} />
        ) : query.data?.availability === 'unavailable' ? (
          <Typography data-testid="payment-review-unavailable">
            Evidence unavailable. Stripe may not be configured, or a provider or ledger lookup failed. No consistency
            conclusion was made.
          </Typography>
        ) : (
          query.data && (
            <>
              <Typography level="body-sm" data-testid="payment-review-coverage">
                Checked {query.data.checkedAt}. Since {query.data.from}. Scanned {query.data.scanned} provider payments
                on this page; showing {query.data.items.length} after server-side filters. Not an account-wide total.
                Settlement grace: 72 hours.
              </Typography>
              {query.data.items.length === 0 && (
                <EmptyState
                  title="No matching records on this page"
                  description="This is not an all-clear. Continue to the next provider page or change filters."
                  action={null}
                />
              )}
              {query.data.items.map(item => (
                <Box
                  key={item.id}
                  sx={{ borderTop: '1px solid', borderColor: 'admin.border', pt: 2 }}
                  data-testid="payment-review-row"
                >
                  <Typography level="title-sm">
                    {item.state}: {item.id}
                  </Typography>
                  <Typography level="body-sm">{item.explanation}</Typography>
                  <Typography level="body-sm">
                    {item.product}; {item.amount} {item.currency.toUpperCase()} minor units; expected credits:{' '}
                    {item.expectedCredits ?? 'unknown'}
                  </Typography>
                  {item.owner && (
                    <Link
                      href={
                        item.owner.type === 'User'
                          ? `/admin/users/${item.owner.id}`
                          : adminOrganizationHref(item.owner.id)
                      }
                      data-testid="payment-review-owner-link"
                    >
                      {item.owner.type}: {item.owner.id}
                    </Link>
                  )}
                  <Link
                    href={`https://dashboard.stripe.com/${item.livemode ? '' : 'test/'}payments/${item.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="payment-review-provider-link"
                  >
                    Open in Stripe (provider access required)
                  </Link>
                  <Box component="details" data-testid="payment-review-timeline">
                    <Box component="summary">Inspect evidence timeline</Box>
                    <Typography level="body-sm">{item.createdAt}: provider payment created</Typography>
                    {item.settledAt && <Typography level="body-sm">{item.settledAt}: charge paid</Typography>}
                    {[
                      ...item.rows.map(row => ({
                        id: row.id,
                        at: row.createdAt,
                        text: `${row.type}: ${row.credits} credits; ${row.status ?? 'no purchase status'}; owner ${row.ownerType}/${row.ownerId}`,
                      })),
                      ...item.refunds.map(refund => ({
                        id: refund.id,
                        at: refund.createdAt,
                        text: `Refund ${refund.status}: ${refund.amount} minor units`,
                      })),
                      ...(item.dispute
                        ? [{ id: item.dispute.id, at: item.dispute.createdAt, text: `Dispute ${item.dispute.status}` }]
                        : []),
                    ]
                      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
                      .map(event => (
                        <Typography level="body-sm" key={event.id}>
                          {event.at}: {event.id}; {event.text}
                        </Typography>
                      ))}
                  </Box>
                </Box>
              ))}
              <Stack direction="row" gap={1}>
                {params.cursor && (
                  <Button onClick={() => filter('cursor', '')} data-testid="payment-review-first-btn">
                    First page
                  </Button>
                )}
                {query.data.nextCursor && (
                  <Button
                    onClick={() => update({ filters: { ...url.filters, cursor: query.data?.nextCursor ?? '' } })}
                    data-testid="payment-review-next-btn"
                  >
                    Next provider page
                  </Button>
                )}
              </Stack>
            </>
          )
        )}
      </Stack>
    </SectionCard>
  );
}
