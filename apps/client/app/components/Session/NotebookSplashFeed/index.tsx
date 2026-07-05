import { Box } from '@mui/joy';
import CommunityFeed from './CommunityFeed';
import RecentActivities from './RecentActivities';
import { useState } from 'react';
import NotebookSplashSection from './NotebookSplashSection';
import SwitchToggleGroup, { ToggleOption } from '@client/app/components/common/SwitchToggleGroup';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

const NotebookSplashFeed = () => {
  const [tabValue, setTabValue] = useState<'recent' | 'community'>('recent');
  const isMobile = useIsMobile();

  const sortOptions: ToggleOption[] = [
    {
      value: 'recent',
      text: 'Recent Activities',
    },
    {
      value: 'community',
      text: 'Community Feed',
    },
  ];
  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 1100,
        maxHeight: 400,
        mx: 'auto',
        mt: 0,
        minHeight: 0,
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      <NotebookSplashSection>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            mb: '16px',
            px: 0,
            width: { xs: '100%', sm: 'fit-content' },
            alignSelf: 'center',
          }}
        >
          <SwitchToggleGroup
            options={sortOptions}
            value={tabValue}
            onChange={v => setTabValue(v as 'recent' | 'community')}
            containerSx={{
              p: 0.5,
              border: (theme: any) => `1px solid ${theme.palette.border.input}`,
              borderRadius: '10px',
              width: '100%',
            }}
            buttonSx={{
              width: isMobile ? '49%' : '180px',
              height: '32px',
              borderRadius: '6px',
              fontWeight: 500,
              fontSize: { xs: '0.9rem', sm: '0.95rem' },
              px: 2,
              py: 1,
              boxShadow: 'none',
              transition: 'background 0.2s, color 0.2s',
              m: 0,
              whiteSpace: 'nowrap',
            }}
          />
        </Box>
        {tabValue === 'recent' && <RecentActivities gridLayout />}
        {tabValue === 'community' && <CommunityFeed gridLayout />}
      </NotebookSplashSection>
    </Box>
  );
};
export default NotebookSplashFeed;
