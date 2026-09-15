import AddFriendModal from '@client/app/components/ProfileModal/CommunityTabContent/AddFriendModal';
import FriendsSection from '@client/app/components/ProfileModal/CommunityTabContent/FriendsSection';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { Box, Typography } from '@mui/joy';
import ActivityFeed from './ActivityFeed';
import { useTranslation } from 'react-i18next';

const CommunityTabContent = () => {
  const { t } = useTranslation();

  return (
    <>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: '1fr 370px',
          },
          gap: '1.25rem',
        }}
      >
        {/* Left Column */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <SectionContainer title={t('projects.joined_projects')}>
            <Typography level="title-lg" color="neutral">
              Coming Soon
            </Typography>
          </SectionContainer>

          <SectionContainer title={t('community.feed')}>
            <ActivityFeed />
          </SectionContainer>
        </Box>

        {/* Right Column */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <FriendsSection />
        </Box>
      </Box>

      {/* Modals */}
      <AddFriendModal />
    </>
  );
};
export default CommunityTabContent;
