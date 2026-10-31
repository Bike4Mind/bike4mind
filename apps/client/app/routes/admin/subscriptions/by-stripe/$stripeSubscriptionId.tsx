import { useEffect } from 'react';
import { Box, Button, LinearProgress, Sheet, Stack, Typography } from '@mui/joy';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import { ErrorState } from '@client/app/components/admin/shared';
import { ADMIN_SUBSCRIPTIONS_TAB_SLUG } from '@client/app/components/admin/Subscriptions/Detail/subscriptionDetailModel';
import { isNotFoundError, useAdminSubscriptionIdByStripeId } from '@client/app/hooks/data/adminSubscriptionDetail';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

/** Resolves a Stripe subscription id (from a Stripe dashboard or alert link) to the detail page. */
const AdminSubscriptionByStripeId = () => {
  useDocumentTitle('Subscription', ' | Admin');
  const { stripeSubscriptionId } = useParams({
    from: '/admin-layout/admin/subscriptions/by-stripe/$stripeSubscriptionId',
  });
  const navigate = useNavigate();
  const lookup = useAdminSubscriptionIdByStripeId(stripeSubscriptionId);
  const resolvedId = lookup.data?.id;

  useEffect(() => {
    if (!resolvedId) return;
    // Replace, so Back skips this hop and returns to wherever the link was opened from.
    void navigate({
      to: '/admin/subscriptions/$subscriptionId',
      params: { subscriptionId: resolvedId },
      replace: true,
    });
  }, [navigate, resolvedId]);

  const backToList = () => navigate({ to: '/admin', search: { [ADMIN_TAB_PARAM]: ADMIN_SUBSCRIPTIONS_TAB_SLUG } });

  const body = () => {
    if (!lookup.isFetching && isNotFoundError(lookup.error)) {
      return (
        <Stack data-testid="subscription-by-stripe-not-found" spacing={1} alignItems="flex-start" sx={{ py: 3 }}>
          <Typography level="title-lg">Subscription not found</Typography>
          <Typography level="body-sm">
            No subscription in our records has the Stripe id {stripeSubscriptionId}.
          </Typography>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => void backToList()}
            data-testid="subscription-by-stripe-back-btn"
          >
            Back to subscriptions
          </Button>
        </Stack>
      );
    }
    if (lookup.isError) {
      return <ErrorState message="This subscription could not be looked up." onRetry={() => void lookup.refetch()} />;
    }
    return <LinearProgress data-testid="subscription-by-stripe-loading" />;
  };

  return (
    <Sheet data-testid="subscription-by-stripe-page" sx={{ minHeight: '100vh', bgcolor: 'admin.canvas' }}>
      <Box sx={{ maxWidth: 1280, mx: 'auto', px: { xs: 2, sm: 4 }, pt: 2.5, pb: 12 }}>{body()}</Box>
    </Sheet>
  );
};

export default AdminSubscriptionByStripeId;
