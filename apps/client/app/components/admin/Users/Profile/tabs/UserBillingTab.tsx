import React from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { DEFAULT_BILLING_RANGE, isBillingRange, type BillingRange } from '@client/app/utils/adminBillingOverview';
import { BillingOverview } from '../../../Billing/BillingOverview';

/** The profile's Billing tab; the window lives in the URL as `?range=` so a link reopens the same view. */
export const UserBillingTab: React.FC<{ userId: string }> = ({ userId }) => {
  const search = useSearch({ strict: false }) as { range?: unknown };
  const navigate = useNavigate({ from: '/admin/users/$userId' });
  const range: BillingRange = isBillingRange(search.range) ? search.range : DEFAULT_BILLING_RANGE;
  return (
    <BillingOverview
      ownerType="user"
      ownerId={userId}
      range={range}
      onRangeChange={next =>
        void navigate({
          search: previous => ({ ...previous, range: next === DEFAULT_BILLING_RANGE ? undefined : next }),
          replace: true,
        })
      }
    />
  );
};
