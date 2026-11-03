import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { SubscriptionDetailPage } from '@client/app/components/admin/Subscriptions/Detail/SubscriptionDetailPage';
import {
  DEFAULT_SUBSCRIPTION_DETAIL_TAB,
  type SubscriptionDetailTab,
} from '@client/app/components/admin/Subscriptions/Detail/subscriptionDetailSearch';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const ROUTE_ID = '/admin-layout/admin/subscriptions/$subscriptionId';

const AdminSubscriptionDetail = () => {
  useDocumentTitle('Subscription', ' | Admin');
  const { subscriptionId } = useParams({ from: ROUTE_ID });
  const { tab = DEFAULT_SUBSCRIPTION_DETAIL_TAB } = useSearch({ from: ROUTE_ID });
  const navigate = useNavigate({ from: '/admin/subscriptions/$subscriptionId' });

  // Replace, so flipping tabs does not stack history entries for Back to walk through.
  const setTab = useCallback(
    (next: SubscriptionDetailTab) =>
      navigate({ search: { tab: next === DEFAULT_SUBSCRIPTION_DETAIL_TAB ? undefined : next }, replace: true }),
    [navigate]
  );

  return <SubscriptionDetailPage subscriptionId={subscriptionId} tab={tab} onTabChange={setTab} />;
};

export default AdminSubscriptionDetail;
