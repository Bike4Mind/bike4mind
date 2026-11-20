import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import { ADMIN_ORGANIZATIONS_TAB_SLUG, ORGS_ORG_ID_PARAM } from '../../organizationsTabSearch';
import { ADMIN_SUBSCRIPTIONS_TAB_SLUG, type OwnerLink } from './subscriptionDetailModel';

/** Every place the detail page links to, so the views take callbacks and stay router-free in tests. */
export const useSubscriptionNavigation = () => {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      backToList: () => navigate({ to: '/admin', search: { [ADMIN_TAB_PARAM]: ADMIN_SUBSCRIPTIONS_TAB_SLUG } }),
      openSubscription: (subscriptionId: string) =>
        navigate({ to: '/admin/subscriptions/$subscriptionId', params: { subscriptionId } }),
      openOwner: (link: OwnerLink) =>
        link.kind === 'user'
          ? navigate({ to: '/admin/users/$userId', params: { userId: link.userId } })
          : navigate({
              to: '/admin',
              search: { [ADMIN_TAB_PARAM]: ADMIN_ORGANIZATIONS_TAB_SLUG, [ORGS_ORG_ID_PARAM]: link.organizationId },
            }),
      openUserLedger: (userId: string) =>
        navigate({ to: '/admin/users/$userId', params: { userId }, search: { tab: 'credits' } }),
    }),
    [navigate]
  );
};

export type SubscriptionNavigation = ReturnType<typeof useSubscriptionNavigation>;
