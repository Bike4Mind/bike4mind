import { Link, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import ApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/ApiKeysSection';
import UserApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/UserApiKeysSection';
import AgentConnectSection from '@client/app/components/ProfileModal/AgentConnectSection';

// Spend for these keys is shown only on the Usage tab, so usage has one home; this tab links to it.
// `replaceHistory`: replace the entry when this sits on /profile (a tab switch), push it when hosted
// on another page, so Back returns there.
const ApiTabContent = ({ replaceHistory = true }: { replaceHistory?: boolean }) => {
  const navigate = useNavigate();

  return (
    <Stack spacing={3}>
      <UserApiKeysSection />

      <Typography level="body-sm" data-testid="api-keys-usage-link">
        Spend by key, model, feature and source is on the{' '}
        <Link
          component="button"
          onClick={() => navigate({ to: '/profile', search: { tab: 'usage' }, replace: replaceHistory })}
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
