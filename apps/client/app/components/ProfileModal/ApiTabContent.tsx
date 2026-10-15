import { Stack, Typography } from '@mui/joy';
import { Link } from '@tanstack/react-router';
import ApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/ApiKeysSection';
import UserApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/UserApiKeysSection';
import AgentConnectSection from '@client/app/components/ProfileModal/AgentConnectSection';

// Keys only. Usage has its own top-level tab; a second usage view in here is what let the two
// disagree (they read different sources - the Usage tab renders CreditAnalyticsTabContent).
const ApiTabContent = () => (
  <Stack spacing={3}>
    <UserApiKeysSection />

    <ApiKeysSection />

    <AgentConnectSection />

    <Typography level="body-sm">
      Credit usage and spend live on the{' '}
      <Link
        to="/profile"
        search={{ tab: 'usage' }}
        style={{ textDecoration: 'underline', color: 'inherit' }}
        data-testid="api-usage-link"
      >
        Usage tab
      </Link>
      .
    </Typography>
  </Stack>
);

export default ApiTabContent;
