import React from 'react';
import { Stack, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { DEFAULT_BILLING_RANGE, isBillingRange, type BillingRange } from '@client/app/utils/adminBillingOverview';
import { ORGS_BILLING_RANGE_PARAM } from '../organizationsTabSearch';
import { BillingOverview } from './BillingOverview';

/** The organization profile's read-only Billing section; its window rides in the URL with `orgId`. */
export const OrganizationBillingSection: React.FC<{ orgId: string }> = ({ orgId }) => {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const value = search[ORGS_BILLING_RANGE_PARAM];
  const range: BillingRange = isBillingRange(value) ? value : DEFAULT_BILLING_RANGE;
  return (
    <Stack gap={1.5} component="section" aria-label="Billing" data-testid="org-profile-billing">
      <Typography level="title-lg" component="h2">
        Billing
      </Typography>
      <BillingOverview
        ownerType="organization"
        ownerId={orgId}
        range={range}
        onRangeChange={next =>
          void navigate({
            to: '/admin',
            search: (previous: Record<string, unknown>) => ({
              ...previous,
              [ORGS_BILLING_RANGE_PARAM]: next === DEFAULT_BILLING_RANGE ? undefined : next,
            }),
            replace: true,
          })
        }
      />
    </Stack>
  );
};
