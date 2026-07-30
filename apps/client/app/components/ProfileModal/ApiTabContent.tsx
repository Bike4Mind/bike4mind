import { Divider, Stack, Typography } from '@mui/joy';
import dynamic from 'next/dynamic';
import { CreditHolderType } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import ApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/ApiKeysSection';
import UserApiKeysSection from '@client/app/components/ProfileModal/SettingsTabContent/UserApiKeysSection';

// Owner-scoped spend breakdown (by key / feature / source), shared with the admin
// and org surfaces; pinned to the current user (ownerType=User). Lives here because
// personal spend that lands on a User-owner pool is predominantly API-key traffic.
const UsageDashboard = dynamic(
  () =>
    import('@client/app/components/admin/CreditAnalysis/components/UsageDashboard').then(m => ({
      default: m.UsageDashboard,
    })),
  { ssr: false }
);

const ApiTabContent = () => {
  const { currentUser } = useUser();

  return (
    <Stack spacing={3}>
      <ApiKeysSection />

      <UserApiKeysSection />

      {currentUser?.id && (
        <>
          <Divider />
          <Typography level="title-md">Usage</Typography>
          <UsageDashboard ownerType={CreditHolderType.User} ownerId={currentUser.id} />
        </>
      )}
    </Stack>
  );
};

export default ApiTabContent;
