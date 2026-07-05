import { Stack } from '@mui/joy';
import ApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/ApiKeysSection';
import UserApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/UserApiKeysSection';

/**
 * Consolidates the system and user API-key management sections.
 */
const ApiKeySection = () => {
  return (
    <Stack spacing={3}>
      {/* API Keys Section */}
      <ApiKeysSection />

      {/* User API Keys Section */}
      <UserApiKeysSection />
    </Stack>
  );
};

export default ApiKeySection;
