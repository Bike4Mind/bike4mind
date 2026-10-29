import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionsFilter';
import { ADMIN_ORGANIZATIONS_TAB_SLUG, adminSearchForTab } from '../adminTabParams';
import { ORGS_ORG_ID_PARAM } from '../organizationsTabSearch';

/**
 * Where a subscription row opens: its owner (the user profile, or the organization in the
 * Organizations tab) until the subscription detail page exists, which then replaces only this hook.
 * A row whose owner record is gone opens nothing.
 */
export function useOpenSubscriptionRow(): (row: AdminSubscriptionRow) => void {
  const navigate = useNavigate();
  return useCallback(
    (row: AdminSubscriptionRow) => {
      if (!row.owner) return;
      if (row.owner.kind === 'User') {
        void navigate({ to: '/admin/users/$userId', params: { userId: row.owner.id } });
        return;
      }
      const orgId = row.owner.id;
      void navigate({
        to: '/admin',
        search: (previous: Record<string, unknown>) => ({
          ...adminSearchForTab(previous, ADMIN_ORGANIZATIONS_TAB_SLUG),
          [ORGS_ORG_ID_PARAM]: orgId,
        }),
      });
    },
    [navigate]
  );
}
