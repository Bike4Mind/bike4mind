import { Link, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import ApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/ApiKeysSection';
import UserApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/UserApiKeysSection';
import AgentConnectSection from '@client/app/components/ProfileModal/AgentConnectSection';

// Spend for these keys is shown only on the Usage tab, so usage has one home; this tab links to it.
const ApiTabContent = () => {
  const navigate = useNavigate();

  return (
    <Stack spacing={3}>
      <UserApiKeysSection />

      <Typography level="body-sm" data-testid="api-keys-usage-link">
        Spend by key, model, feature and source is on the{' '}
        <Link
          component="button"
          onClick={() => navigate({ to: '/profile', search: { tab: 'usage' }, replace: true })}
          data-testid="api-keys-usage-link-btn"
        >
          Usage tab
        </Link>
        .
      </Typography>

      <AgentConnectSection />

      <ApiKeysSection />
    </Stack>
  );
};

export default ApiTabContent;
