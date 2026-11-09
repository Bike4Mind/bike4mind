import React from 'react';
import { Stack, Typography } from '@mui/joy';
import { CLIENT_SURFACES } from '@bike4mind/common';
import { Fact, RelativeTime, SectionCard, formatUtc } from '../../../shared';
import { CLIENT_SURFACE_LABELS, type AdminUserProfile } from '../userProfileModel';

/**
 * Which clients (web, desktop app, CLI, API) the user has called from, per `user.clientUsage`.
 * A dash means not seen since recording began, not "never used": older use was not backfilled.
 */
export const ClientsCard: React.FC<{ user: AdminUserProfile }> = ({ user }) => (
  <SectionCard title="Clients" data-testid="user-profile-clients-card">
    {CLIENT_SURFACES.map(surface => {
      const entry = user.clientUsage?.[surface];
      return (
        <Fact key={surface} label={CLIENT_SURFACE_LABELS[surface]} data-testid={`user-profile-client-${surface}`}>
          {entry && (
            <Stack direction="row" alignItems="center" gap={0.75} flexWrap="wrap">
              {entry.version && <Typography level="body-sm">{entry.version}</Typography>}
              <RelativeTime prefix="Last used" at={entry.lastSeenAt} />
              <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                {`First ${formatUtc(new Date(entry.firstSeenAt)).split(',')[0]}`}
              </Typography>
            </Stack>
          )}
        </Fact>
      );
    })}
  </SectionCard>
);
