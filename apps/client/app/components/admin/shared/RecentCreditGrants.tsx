import React from 'react';
import { Stack, Typography } from '@mui/joy';
import { creditsToUsd } from '@bike4mind/common';
import { useAdminRecentCreditGrants } from '@client/app/hooks/data/adminUserCredits';
import { formatUtc } from './EntityHeader';

const formatGrant = (credits: number) => `+${credits.toLocaleString('en-US')} credits (${creditsToUsd(credits)})`;

/**
 * The recipient's latest admin grants in the grant cap window, so an admin sees what others already granted
 * before adding more (server/admin/creditGrants/tierCap.ts counts the same rows).
 */
export const RecentCreditGrants: React.FC<{ userId: string; 'data-testid': string }> = ({
  userId,
  'data-testid': testId,
}) => {
  const query = useAdminRecentCreditGrants(userId);
  const muted = { color: 'admin.inkMuted' } as const;

  const body = (() => {
    if (query.isLoading) {
      return (
        <Typography level="body-xs" sx={muted}>
          Loading recent grants...
        </Typography>
      );
    }
    if (!query.data) {
      return (
        <Typography level="body-xs" sx={muted} data-testid={`${testId}-error`}>
          Recent grants could not be loaded.
        </Typography>
      );
    }
    if (query.data.grants.length === 0) {
      return (
        <Typography level="body-xs" sx={muted} data-testid={`${testId}-empty`}>
          No admin grants in the last 24 hours.
        </Typography>
      );
    }
    return query.data.grants.map((grant, index) => (
      <Typography key={`${grant.at}-${index}`} level="body-xs" data-testid={`${testId}-row-${index}`}>
        {formatUtc(new Date(grant.at))}: {formatGrant(grant.credits)} by {grant.grantedBy}
      </Typography>
    ));
  })();

  return (
    <Stack gap={0.25} data-testid={testId}>
      <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
        Recent admin grants (last 24 hours)
      </Typography>
      {body}
    </Stack>
  );
};
