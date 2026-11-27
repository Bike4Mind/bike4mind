import VisibilityIcon from '@mui/icons-material/Visibility';
import { Button } from '@mui/joy';
import React from 'react';
import { useOpenUserProfile } from '@client/app/components/admin/Users/Profile/useOpenUserProfile';

interface ViewUserProfileProps {
  userId: string;
  size?: 'sm' | 'md' | 'lg';
}

const ViewUserProfile: React.FC<ViewUserProfileProps> = ({ userId, size = 'md' }) => {
  const openUserProfile = useOpenUserProfile();

  return (
    <Button
      size={size}
      variant="outlined"
      color="neutral"
      startDecorator={<VisibilityIcon />}
      onClick={() => void openUserProfile(userId)}
      data-testid="view-user-profile-btn"
    >
      View
    </Button>
  );
};

export default ViewUserProfile;
