import { Box, Typography } from '@mui/joy';
import { APP_NAME } from '@client/config/general';

interface CommunityFeedProps {
  gridLayout?: boolean;
}

const CommunityFeed = ({ gridLayout }: CommunityFeedProps) => {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%' }}>
      <Box
        sx={{
          padding: '16px',
          minHeight: 130,
          height: '130px',
          width: '100%',
          maxWidth: 500,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        <Typography level="body-sm" textAlign="center" color="neutral">
          See what others are using{APP_NAME ? ` ${APP_NAME}` : ' it'} for. Add friends, join Projects, or share your
          own!
        </Typography>
      </Box>
    </Box>
  );
};

export default CommunityFeed;
