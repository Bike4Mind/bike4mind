import UserApiKeysTab from '@client/app/components/profile/UserApiKeysTab';
import SectionContainer from '../SectionContainer';
import { APP_NAME, getBrandName } from '@client/config/general';

const UserApiKeysSection = () => {
  return (
    <SectionContainer
      title={APP_NAME ? `${getBrandName()} API keys` : 'Platform API keys'}
      subtitle={`Create and manage API keys for programmatic access to your${APP_NAME ? ` ${APP_NAME}` : ''} account. These keys allow you to authenticate with our API without using your login credentials.`}
    >
      <UserApiKeysTab />
    </SectionContainer>
  );
};

export default UserApiKeysSection;
