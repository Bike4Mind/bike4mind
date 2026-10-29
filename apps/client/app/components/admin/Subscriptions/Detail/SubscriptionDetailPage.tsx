import React from 'react';
import { Box, Button, Sheet, Skeleton, Stack, Typography } from '@mui/joy';
import {
  isNotFoundError,
  isSubscriptionObjectId,
  useAdminSubscriptionDetail,
} from '@client/app/hooks/data/adminSubscriptionDetail';
import { ErrorState, UndoToastProvider } from '../../shared';
import { SubscriptionDetailView } from './SubscriptionDetailView';
import { useSubscriptionNavigation } from './useSubscriptionNavigation';
import type { SubscriptionDetailTab } from './subscriptionDetailSearch';

type SubscriptionDetailPageProps = {
  subscriptionId: string;
  tab: SubscriptionDetailTab;
  onTabChange: (tab: SubscriptionDetailTab) => void;
};

/** Shaped like the header, stat strip and cards, so the page does not jump when the data lands. */
const DetailSkeleton: React.FC = () => (
  <Stack gap={2.5} data-testid="subscription-detail-loading" aria-busy="true">
    <Skeleton variant="text" level="body-sm" width={200} />
    <Skeleton variant="text" level="h1" width={320} />
    <Skeleton variant="rectangular" height={96} sx={{ borderRadius: 'lg' }} />
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
      <Skeleton variant="rectangular" height={280} sx={{ borderRadius: 'lg' }} />
      <Skeleton variant="rectangular" height={280} sx={{ borderRadius: 'lg' }} />
    </Box>
  </Stack>
);

/** The admin detail of one subscription at /admin/subscriptions/$subscriptionId; the layout guards it to admins. */
export const SubscriptionDetailPage: React.FC<SubscriptionDetailPageProps> = ({ subscriptionId, tab, onTabChange }) => {
  const navigation = useSubscriptionNavigation();
  const detail = useAdminSubscriptionDetail(subscriptionId);

  // A malformed id is never fetched: it is a not-found, like an unknown one.
  const isNotFound = !isSubscriptionObjectId(subscriptionId) || (!detail.isFetching && isNotFoundError(detail.error));

  const renderBody = () => {
    if (isNotFound) {
      return (
        <Stack data-testid="subscription-detail-not-found" spacing={1} alignItems="flex-start" sx={{ py: 3 }}>
          <Typography level="title-lg">Subscription not found</Typography>
          <Typography level="body-sm">
            No subscription has the id {subscriptionId}. It may have been removed.
          </Typography>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => void navigation.backToList()}
            data-testid="subscription-detail-not-found-back-btn"
          >
            Back to subscriptions
          </Button>
        </Stack>
      );
    }
    if (detail.isLoading) return <DetailSkeleton />;
    if (!detail.data) {
      return (
        <ErrorState
          message="This subscription could not be loaded."
          onRetry={() => void detail.refetch()}
          retrying={detail.isFetching}
        />
      );
    }
    return <SubscriptionDetailView detail={detail.data} tab={tab} onTabChange={onTabChange} navigation={navigation} />;
  };

  return (
    <Sheet
      data-testid="subscription-detail-page"
      sx={{ minHeight: '100vh', overflowY: 'auto', bgcolor: 'admin.canvas' }}
    >
      {/* Keyed so an undo offered on one subscription never carries over to the next. */}
      <UndoToastProvider key={subscriptionId}>
        <Box sx={{ maxWidth: 1280, mx: 'auto', px: { xs: 2, sm: 4 }, pt: 2.5, pb: 12 }}>{renderBody()}</Box>
      </UndoToastProvider>
    </Sheet>
  );
};
