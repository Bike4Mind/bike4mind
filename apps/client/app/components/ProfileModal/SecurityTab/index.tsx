import React from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useQueryClient } from '@tanstack/react-query';
import { useUser } from '@client/app/contexts/UserContext';
import { API_USAGE_QUERY_KEY, BLOCKED_IPS_KEY, USER_RECENT_7D_KEY } from '@client/app/hooks/data/admin';
import { MFA_STATUS_QUERY_KEY } from '@client/app/hooks/data/mfa';
import { OAUTH_GRANTS_QUERY_KEY } from '@client/app/hooks/data/oauthGrants';
import { PASSKEYS_QUERY_KEY } from '@client/app/hooks/data/passkeys';
import { TRUSTED_DEVICES_QUERY_KEY } from '@client/app/hooks/data/trustedDevices';
import { ACTIVE_SESSIONS_KEY } from '@client/app/hooks/data/user';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import MfaCard from '@client/app/components/ProfileModal/SettingsTabContent/MfaCard';
import ActiveSessionsSection from '@client/app/components/ProfileModal/SettingsTabContent/ActiveSessionsSection';
import ApprovedAppsSection from '@client/app/components/ProfileModal/SettingsTabContent/ApprovedAppsSection';
import SignInActivitySection from './SignInActivitySection';
import { SupportAccessActivity, SUPPORT_ACCESS_QUERY_KEY } from './SupportAccessActivity';
import ApiKeyUsageSection from './ApiKeyUsageSection';
import BlockedIPsSection from './BlockedIPsSection';

export const SECURITY_TAB_QUERY_KEYS = [
  MFA_STATUS_QUERY_KEY,
  PASSKEYS_QUERY_KEY,
  TRUSTED_DEVICES_QUERY_KEY,
  ACTIVE_SESSIONS_KEY,
  USER_RECENT_7D_KEY,
  SUPPORT_ACCESS_QUERY_KEY,
  OAUTH_GRANTS_QUERY_KEY,
  API_USAGE_QUERY_KEY,
  BLOCKED_IPS_KEY,
] as const;

const SecurityTab: React.FC = () => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();

  const handleRefresh = async () => {
    await Promise.all(SECURITY_TAB_QUERY_KEYS.map(queryKey => queryClient.invalidateQueries({ queryKey })));
  };

  return (
    <Stack spacing={3} sx={{ p: 2 }} data-testid="security-tab-root">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'flex-start' }}
        gap={1.5}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography level="h3">Security</Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            Two-factor sign-in, your signed-in devices, sign-in attempts against your account and your API keys.
          </Typography>
        </Box>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<RefreshIcon fontSize="small" />}
          onClick={handleRefresh}
          data-testid="security-summary-refresh-btn"
          sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'auto' } }}
        >
          Refresh
        </Button>
      </Stack>

      <Box data-testid="security-mfa-section">
        <SectionContainer title="Two-factor authentication">
          <MfaCard />
        </SectionContainer>
      </Box>

      <Box data-testid="security-sessions-section">
        <SectionContainer title="Signed-in devices">
          <ActiveSessionsSection />
        </SectionContainer>
      </Box>

      <Box data-testid="security-signin-activity-section">
        <SignInActivitySection />
      </Box>

      <Box data-testid="security-support-access-section">
        <SectionContainer
          title="Support access"
          subtitle="Times support signed in to your account, and how long each visit lasted."
        >
          <SupportAccessActivity />
        </SectionContainer>
      </Box>

      <Box data-testid="security-approved-apps-section">
        <SectionContainer
          title="Approved apps"
          subtitle="Third-party apps you have authorized to access your account. Revoking an app stops it from renewing access; a session it already holds may continue for up to 30 minutes."
        >
          <ApprovedAppsSection />
        </SectionContainer>
      </Box>

      <Box data-testid="security-api-keys-section">
        <ApiKeyUsageSection />
      </Box>

      {currentUser?.isAdmin && (
        <Box data-testid="security-blocked-ips-section">
          <BlockedIPsSection />
        </Box>
      )}
    </Stack>
  );
};

export default SecurityTab;
