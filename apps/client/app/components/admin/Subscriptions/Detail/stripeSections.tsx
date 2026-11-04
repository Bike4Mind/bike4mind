import React, { type ReactNode } from 'react';
import { Box, Button, Skeleton, Stack } from '@mui/joy';
import type { AdminSubscriptionStripeState } from '@client/app/hooks/data/adminSubscriptionDetail';
import type { AdminSubscriptionStripe } from '@client/app/utils/adminSubscriptionStripe';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { EmptyState, ErrorState } from '../../shared';
import { SELF_HOST_DOCS_URL } from '../../shared/selfHostDocs';

export type StripeData = Extract<AdminSubscriptionStripe, { kind: 'stripe' }>;

export const STRIPE_ERROR_MESSAGE = 'Stripe request failed. The rest of this page is from our records.';

const INVOICE_STATUS_TONES: Record<string, AdminStatusTone> = {
  paid: 'good',
  open: 'info',
  uncollectible: 'bad',
};

export const invoiceStatusTone = (status: string | null): AdminStatusTone =>
  (status && INVOICE_STATUS_TONES[status]) || 'neutral';

/**
 * The states every Stripe-backed section shares (spec 5.6): loading, Stripe down, not configured, no record.
 * Renders `children` only once there is live data, so a failure stays inside the section it hit.
 */
export const StripeSection: React.FC<{
  stripe: AdminSubscriptionStripeState;
  testIdPrefix: string;
  children: (data: StripeData) => ReactNode;
}> = ({ stripe, testIdPrefix, children }) => {
  const { data } = stripe;
  if (data?.stripeConfigured && data.kind === 'stripe') return <>{children(data)}</>;
  if (!data && stripe.isLoading) {
    return (
      <Stack gap={1} sx={{ p: 2 }} aria-busy="true" data-testid={`${testIdPrefix}-loading`}>
        <Skeleton variant="text" level="body-md" width="60%" />
        <Skeleton variant="text" level="body-md" width="40%" />
        <Skeleton variant="text" level="body-md" width="50%" />
      </Stack>
    );
  }
  if (!data) {
    return (
      <Box data-testid={`${testIdPrefix}-error`}>
        <ErrorState message={STRIPE_ERROR_MESSAGE} onRetry={stripe.refetchFresh} retrying={stripe.isFetching} />
      </Box>
    );
  }
  if (!data.stripeConfigured) {
    return (
      <Box data-testid={`${testIdPrefix}-unconfigured`}>
        <EmptyState
          title="Stripe isn't configured on this deployment"
          description="Card and invoices come from Stripe. Comps still work without it."
          action={
            <Button
              variant="outlined"
              component="a"
              href={SELF_HOST_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`${testIdPrefix}-self-host-docs-link`}
            >
              Read the self-host docs
            </Button>
          }
        />
      </Box>
    );
  }
  return (
    <Box data-testid={`${testIdPrefix}-empty`}>
      <EmptyState
        title={
          data.kind === 'comp' ? 'Comped plans have no Stripe invoices' : 'Stripe has no record of this subscription'
        }
        action={null}
      />
    </Box>
  );
};
