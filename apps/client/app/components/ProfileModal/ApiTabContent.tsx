import { Stack } from '@mui/joy';
import ApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/ApiKeysSection';
import UserApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/UserApiKeysSection';

const ApiTabContent = () => {
  return (
    <Stack spacing={3}>
      {/* API Keys Section */}
      <ApiKeysSection />

      {/* User API Keys Section */}
      <UserApiKeysSection />
    </Stack>
  );
};

export default ApiTabContent;
