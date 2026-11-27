import React from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { useAdminUserOAuthApps } from '@client/app/hooks/data/adminUserOAuthApps';
import { Fact, RelativeTime, SectionCard, formatUtc } from '../../../shared';

/** The apps this user has signed in to with Sign in with Bike4Mind, newest sign-in first. */
export const OAuthAppsCard: React.FC<{ userId: string }> = ({ userId }) => {
  const { data, isLoading, isError, refetch } = useAdminUserOAuthApps(userId);
  const apps = data?.apps ?? [];

  return (
    <SectionCard title="Apps (Sign in with Bike4Mind)" data-testid="user-profile-oauth-apps-card">
      {isLoading && <Typography level="body-sm">Loading apps...</Typography>}
      {isError && (
        <Button
          variant="outlined"
          size="sm"
          onClick={() => void refetch()}
          data-testid="user-profile-oauth-apps-retry-btn"
        >
          Reload apps
        </Button>
      )}
      {data && apps.length === 0 && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="user-profile-oauth-apps-empty">
          No sign-ins through other apps recorded
        </Typography>
      )}
      {apps.map(app => (
        <Fact
          key={app.clientId}
          label={app.name ?? app.clientId}
          data-testid={`user-profile-oauth-app-${app.clientId}`}
        >
          <Stack direction="row" alignItems="center" gap={0.75} flexWrap="wrap">
            <RelativeTime prefix="Last sign-in" at={app.lastSignInAt} />
            <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
              {`First ${formatUtc(new Date(app.firstSignInAt)).split(',')[0]}`}
            </Typography>
          </Stack>
        </Fact>
      ))}
    </SectionCard>
  );
};
